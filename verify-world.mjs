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
import { readFileSync } from 'node:fs'
// slice 11: the fake audio replays the world's frame through the *real* router, so
// this harness needs the pure half of the audio module. It is a pure module per
// §15.1, which is the property that makes this import possible at all.
import { routeAudio } from './src/game/audio.js'
// iteration 2, pass 3: the first Three.js import in this harness, and the reason
// is that the portal gate's claim is a claim about a *scene graph* — "a camera on
// the §16.5.5 stand-off hits the gate first, and not the shell in front of it" —
// which has an answer to be had from a raycast and no answer at all in a string
// in a source file. The world built here is the real one (`streetView.js` imports
// Three.js itself and always has), so the only thing being stubbed here is the
// 2D canvas and the renderer, neither of which a raycast touches.
import * as THREE from 'three'

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
    //
    // `putImageData` KEEPS what it is given, and that is a change from a no-op.
    // It is what lets pass 8's tileability gate measure the shimmer's own
    // pixels: the question "does this texture meet itself cleanly at its tile
    // edge" is a property of the generated image and of nothing else, and a stub
    // that throws the image away can only ever be asked it as a source regex.
    // Storing the last image per canvas is enough — three.js keeps one texture
    // per canvas here, and the gate reads it straight back off `map.image`.
    createImageData(width, height) {
      const w = Math.max(1, Math.ceil(Number(width) || 1))
      const h = Math.max(1, Math.ceil(Number(height) || 1))
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    },
    getImageData(x, y, width, height) {
      return this.createImageData(width, height)
    },
    putImageData(image) {
      if (image && image.data) canvas.pixels = image
    },

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
// slice 16: `loop.js` is deleted, so this reads `store.js`, which is where the
// phase table and the store now live. `createStartStore` replaces v1's
// `createInitialState(1, PHASE.START)` verbatim — the title-screen state is the
// one fact three entry points (here, `App.jsx` and the capture page) must agree
// on, and having it be a named call rather than a hand-written literal is what
// stops this harness drifting into a third starting state.
const { createStartStore, PHASE } = await import('./src/game/store.js')
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
// PASS 10 REVIEW: the capture set as DATA, read here so the checks below can ask
// what a view is actually staged to do rather than re-typing a wait that the
// gallery owns. `capture.js` is pure (§16.5's set is a frozen table of steps) and
// is already imported by `verify.mjs`, so importing it here is not a new
// dependency — it is the same table, and a copy of it in this file would be a
// second thing to keep right.
const cap = await import('./src/game/capture.js')
// ITERATION 2, PASS 13. The audio's PURE half is already imported above
// (`routeAudio`); the world bed's schedule and its spatial model are the other
// half of the same module, and a check that re-derived them would be asserting a
// copy. `skyView.js` reaches for Three.js, which is why `verify.mjs` reads it as
// text and this file imports it: §15.2's seam, in the direction the seam runs.
const audioModule = await import('./src/game/audio.js')
const { hazeIntensityAt, HAZE_AUDIO_CYCLE } = await import('./src/game/skyView.js')

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

/**
 * placeCreature — stand the creature `dx`, `dz` metres from the player, in the frame
 * the world actually keeps it in.
 *
 * `creaturePosition` is *canonical* (§3.3's contract: the node table's own frame) and
 * the player's coordinates are not — they run monotonically and the world slides
 * behind them in whole periods. A check that writes `player.pos + 2` is writing a
 * world position into a canonical field, and the world — which folds the creature
 * into the copy the player is standing in, because that is the copy both of them
 * can see — reads it as a whole period away: 270 m instead of 2 in the default run.
 *
 * The balance simulation found the same seam in gameplay code, where it made the
 * game unlosable; this is the harness's version of it, and it is why the swing
 * reach, the capture radius and the awareness meter were all being measured at
 * hundreds of metres. One helper, so the frame is stated once.
 */
function placeCreature(game, dx, dz = 0) {
  game.creaturePosition = {
    x: hood.canonicalCoord(game.player.pos.x) + dx,
    z: hood.canonicalCoord(game.player.pos.z) + dz,
  }
  return game.creaturePosition
}

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

const store = createStartStore()
const audio = makeFakeAudio()
const game = new BellLoopGame(container, { store, audio, createRenderer: makeFakeRenderer })

// ---------------------------------------------------------------------------
// iteration 2, pass 12 — the portal's descent, on the built scene
// ---------------------------------------------------------------------------
//
// WHAT THIS FILE IS FOR, AND WHY IT IS NOT A COPY OF verify.mjs
// -----------------------------------------------------------
// `verify.mjs` proves the NUMBERS: the ramp is C1, the ring clears the pupil, the
// collapse eases in, the lens is zero on the hole. All four are claims about a pure
// function, and a pure function is not a scene graph. This file proves the four
// things a pure function cannot:
//
//   1. THE NEAR FIELD IS REACHED. `portalNearness` returns a number for any
//      distance handed to it, and this file has to put a real camera at a real
//      portal and find that the swirl in the BUILT scene turns faster than it does
//      from across the street. Without it, a `setViewer` nobody calls, a fold that
//      is wrong, or a facing dot that is always negative are all invisible to
//      every check in the other file.
//   2. THE DEBRIS IS IN THE FRAME. Pass 10's review found a trail in no frame and
//      no gate able to see that, and pass 11 answered it with a projection. This is
//      the same discipline for a ring: the matrices are read back out of the built
//      `InstancedMesh` and projected through the real camera.
//   3. THE COLLAPSE IS TIMED, AND §5.3 STILL HOLDS ON THE FRAME IT STARTS. The
//      pass-3 check reads a shut portal's materials; this one reads them on the
//      exact frame `setPortalShut` returns, which is the frame the whole argument
//      is about.
//   4. THE BALANCE SIMULATION IS UNMOVED. The strongest statement this pass can
//      make about its own timing is that the 0.8 s collapse changes nothing a
//      player can act on, and the only way to say that is to run the real
//      three-portal sequence and compare the state with and without it.
// ---------------------------------------------------------------------------

/**
 * Stand the player `back` metres from a portal, facing it, and run one frame.
 *
 * The same arithmetic `capture.js`'s `goto` op does, written out here rather than
 * shared: `capture.js` is the page's step list and this is a harness fixture, the
 * two have been edited by different passes for different reasons, and a shared
 * helper would be a second thing to change.
 */
function standAtPortal(portal, back) {
  const drawn = game.streetView.worldOf(portal.position)
  const facing = portal.facing
  game.player.teleport(drawn.x - facing.x * back, drawn.z - facing.z * back, Math.atan2(-facing.x, -facing.z))
  game.update(DT)
  return drawn
}

// The view's own idle swirl table, read out of the source. A first version of the
// near-field check below asserted "the swirl does not turn at 30 m at all", which
// is not what nearness 0 means: nearness 0 means the multiplier is 1, so the
// swirl turns at exactly the table's rate. Asserting zero would have passed only if
// the whole swirl had stopped. The table is read from the source rather than
// restated here for the reason every other section in this repository reads a
// constant out of a file: two places to change one number is one place too many.
const STREET_VIEW_TEXT = readFileSync(new URL('./src/game/streetView.js', import.meta.url), 'utf8')
const IDLE_SWIRL_RATES = [
  .../const PORTAL_SWIRL_RATES = Object\.freeze\(\[([^\]]+)\]\)/.exec(STREET_VIEW_TEXT)[1].matchAll(/-?[\d.]+/g),
].map(Number)

// PASS12_WORLD

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

check('the world builds a street, three portals, a hammer and an exit car', () => {
  assert.equal(store.get().phase, PHASE.START)
  assert.equal(game.streetView.loop, 1)
  assert.equal(game.streetView.portals.length, 3, '§3.3: one portal per district')
  assert.deepEqual(
    game.streetView.portals.map((entry) => entry.id),
    [...hood.PORTAL_IDS],
    'and the ids are the rules\' own, not three re-typed strings',
  )
  assert.ok(game.streetView.hammer.root, 'the hammer is missing from the world')
  assert.equal(game.streetView.hammer.taken, false)
  assert.ok(game.streetView.exitCar.root, 'the exit car is missing from the world')
  assert.equal(game.streetView.exitCar.lit, false, '§10.3: the car is dark in Act I')
  // §3.3's fold: the whole neighbourhood hangs off one group, so the wrap is a
  // single translate. If that group were missing, every later check in this file
  // would still pass and the player would be walking in a void.
  assert.equal(game.scene.getObjectByName('street'), game.streetView.group)
  // the streets the player collides with, and the Act I opening state
  assert.ok(game.player.colliders.length > 100, `only ${game.player.colliders.length} colliders`)
  assert.equal(game.creature.state, 'telegraph', '§6.1: Act I opens as a sighting')
  assert.equal(game.player.enabled, false, 'the player must be frozen behind the start overlay')
})

check('BEGIN starts the run, and rings no bell (§13 removed the opening toll)', () => {
  game.start()
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.player.enabled, true)
  // v1's opening toll was the *world's* clock announcing sixty seconds. §13 keeps
  // the bell and changes what it is for, and §9 says there is no timer at all, so
  // the first toll in a v2 run is the awakening — and the awakening is the hammer's.
  assert.equal(
    audio.calls.some((name) => ['awakening', 'banish', 'whiff', 'reset'].includes(name)),
    false,
    'BEGIN rang a toll: v1 opened the loop with the world\'s clock, and v2 has no clock',
  )
  run(game, 4)
  // §9.3's black belongs to the capture, and the one other place a fade exists is
  // BEGIN's own: `start()` puts `fade` back to 1 so the hand-off from the title
  // card to the player is a dissolve rather than a cut. PLAYING therefore has to
  // keep lifting it, because `fade` is painted as a full-viewport `background:
  // #000` rect over the canvas — a value still standing at 1 is not a dark
  // street, it is a run nobody can see.
  //
  // This assertion used to be the weaker "the mirror agrees with the world",
  // which was written on the reasoning that `_updatePlaying` never touches
  // `fade` again and so whatever the last setter left is fine. That reasoning
  // described the bug and then excused it: the two sides agreed on `1` forever,
  // the gate stayed green, and twelve of the fourteen gallery frames were
  // photographs of a black rectangle. The number the design implies is zero.
  assert.equal(game.fade, 0, 'four seconds into a run the screen is still black')
  assert.equal(store.get().fade, 0, 'and the HUD is still painting the black over it')
  // §9: the thing that used to be the timer is now the run's own state, and none of
  // it is counting down — it is three portals, a hammer and a creature.
  assert.equal(game.state.loop, 1)
  assert.equal(game.state.hammerHeld, false)
})

check('the player can walk: input moves the body, the camera follows, footsteps are routed', () => {
  const before = game.player.pos.clone()
  game.player.pressKey('KeyW')
  run(game, 1.2)
  game.player.releaseKey('KeyW')
  const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z)
  assert.ok(moved > 1, `moved only ${moved.toFixed(2)}m`)
  assert.ok(
    audio.calls.some((name) => ['walk', 'sprint', 'exhausted'].includes(name)),
    'no footsteps emitted',
  )
  // the camera rides the body with the bob's own tolerance, so the two are compared
  // with a hair of slack rather than for strict equality
  assert.ok(
    Math.abs(game.camera.position.x - game.player.pos.x) < 0.2,
    'the camera should follow the player',
  )
  assert.ok(game.camera.position.y > 1.4 && game.camera.position.y < 1.8)
})

check('the streets are solid and the world is a wrap, not a maze', () => {
  // the v1 twin of this check was "the player cannot walk out of the maze". v2 has
  // no edge to fall off: the player may walk forever, because §3.2's answer is that
  // the street repeats. What must be solid is the *stuff* — houses, hedges, cars.
  //
  // Walked into, not teleported into: `_resolvePenetration` runs on movement, so
  // a body *placed* inside a box is not the same question as a body that walks at
  // one. Spawn on an intersection, aim at the nearest building, and hold W.
  game.player.teleport(hood.SPAWN.position.x, hood.SPAWN.position.z, hood.SPAWN.yaw ?? 0)
  const target = game.player.colliders[0]
  const towards = Math.atan2(
    (target.minX + target.maxX) / 2 - game.player.pos.x,
    (target.minZ + target.maxZ) / 2 - game.player.pos.z,
  )
  game.player.teleport(game.player.pos.x, game.player.pos.z, towards)
  game.player.pressKey('KeyW')
  run(game, 3)
  game.player.releaseKey('KeyW')
  const inside =
    game.player.pos.x > target.minX &&
    game.player.pos.x < target.maxX &&
    game.player.pos.z > target.minZ &&
    game.player.pos.z < target.maxZ
  assert.equal(inside, false, 'the player walked into a building and stayed there')
  // and the wrap: walk a whole period and the street is still drawn around you,
  // because the player never wraps and the world slides instead (§3.3)
  const origin = { ...game.streetView.origin }
  game.player.teleport(game.player.pos.x + hood.WORLD_EXTENT * 2, game.player.pos.z, 0)
  game.update(DT)
  assert.notDeepEqual(game.streetView.origin, origin, 'the world did not slide to follow the player')
  // the slide is the *whole* trick, so it has to be an exact number of periods: an
  // off-by-a-metre origin would put the seam in shot and no assertion here would
  // notice, because the street still looks like a street.
  for (const axis of ['x', 'z']) {
    const periods = (game.streetView.origin[axis] - origin[axis]) / hood.WORLD_EXTENT
    assert.ok(Number.isInteger(periods), `the ${axis} slide is not a whole number of periods (${periods})`)
  }
})

check('the prompt is the nearest objective and nothing else', () => {
  // §5.2's two verbs need something to be near. v1's twin was the candle prompt;
  // v2 has three answers and the world picks between them by distance alone.
  const portal = game.streetView.portals[0]
  const atPortal = game.streetView.worldOf(portal.position)
  game.player.teleport(atPortal.x, atPortal.z, 0)
  run(game, DT)
  assert.equal(store.get().prompt, 'portal', 'standing at a portal shows no prompt')
  const hammer = game.streetView.worldOf(game.streetView.hammer.position)
  game.player.teleport(hammer.x, hammer.z, 0)
  run(game, DT)
  assert.equal(store.get().prompt, 'hammer', 'standing at the hammer shows no prompt')
  game.player.teleport(atPortal.x + 60, atPortal.z + 60, 0)
  run(game, DT)
  assert.equal(store.get().prompt, null, 'a prompt is showing from nowhere')
})

// TEARDOWN IS AT THE BOTTOM OF THIS FILE, with the other two. It was here in v1,
// one block up from the end, and slice 14 moved it: `dispose()` frees the street,
// the player and the creature view, and every block below this line drives all
// three. A teardown in the middle of a suite does not fail loudly — the checks
// after it keep passing against a half-freed world, because `update` has no
// `disposed` guard of its own and the stale geometry still answers. The v1 file
// hid that because the block after it never ran.

// The checks that were here and are gone, and where each one went:
//   - "the chamber is sealed while the door is shut"   -> no chamber, no door
//   - "candles: proximity shows the prompt, E lights"  -> the prompt check above
//   - "the bell rings at 60s" and "lighting the last
//      two candles opens the door on the next loop"    -> no timer, no candles.
//     §9 deleted the countdown, and the capture/reset cycle those two checks
//     drove is asserted three times over in the slice-10 and slice-13 blocks
//     below (`a capture resets the player to spawn`, `a capture on its own
//     removes the figure`, `BEGIN AGAIN is a full wipe`).
//   - "walking into the open chamber wins"             -> the slice-13 block's
//     `walking into the exit wins, rings once, and freezes the world`
//   - "the world freezes after the win" and "BEGIN AGAIN wipes the run" -> the
//     same two slice-13 checks, on v2's own win condition.

// ---------------------------------------------------------------------------
// slice 10 — the creature view and the capture loop
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK WAS PARKED, AND WHAT UN-PARKING IT COST
// -------------------------------------------------------
// Slice 10 added `creatureView.js` and the whole Act I -> Act II -> capture ->
// reset cycle, and every one of its world-level claims belongs here. But the
// harness did not run, so anything appended to it would have been unreachable:
// the list would look like coverage and measure nothing, which is worse than no
// list. So it was written out in full, as source, with the assertion text that
// would be used — and slice 10's *pure* half went into `verify.mjs` instead,
// where it actually ran.
//
// The split follows §15.2's seam. What is provable in node — the presentation
// policy, the eye pixel floor, the per-state tells, the §7.4 ladder, the §9.1
// persistence table, the §7.2 awakening — is in `creature.js` and is asserted in
// `verify.mjs`. What is left is the part that genuinely needs a renderer.
//
// The predictions in the old header, kept because two of them were right and one
// was the reason the log's "24/31" control run was optimistic:
//   - "all ten of these were written and run against the *current* stub ... so
//     slice 14 should find them nearly drop-in" — they were not drop-in. Four
//     needed work, and the fourth was a real bug in `world.js` that the block was
//     written to catch and could not, because the check it was written against
//     assumed the sighting was at long range. It was at zero. See the file header.
//   - "one needs `document.removeEventListener` added to the stub before
//     `dispose()` can be checked at all" — the stub has it, and the `dispose()`
//     check is at the bottom of this file with the other one.

check('the game constructs a creature view and an Act I apparition', () => {
  // `world.js` builds the view in its constructor and places §6.1's first
  // sighting in front of the spawn. The telegraph is the only thing on the title
  // screen that says there is something out here, so it must be drawn there.
  //
  // `restart()` first because this check is about the *opening* state and the block
  // above it has been playing: `START` is a moment, and a suite that asserts on it
  // has to put the world back in it. Every check below this one does the same, and
  // the first two are the only ones that need it, because they are the only ones
  // about the run's first four seconds.
  game.restart()
  run(game, 1.6)
  assert.ok(game.creatureView, 'no creature view')
  assert.equal(game.creatureView.disposed, false)
  assert.equal(game.creature.state, 'telegraph', 'Act I opens as a telegraph')
  assert.equal(game.creatureView.root.visible, true, 'the apparition is on the title screen')
  // ITERATION 2, PASS 15. BEFORE: `presence < 0.3`, which was the Act I apparition's
  // own `presence` column and made this a restatement of the table. AFTER: the claim
  // is the one the title screen actually has to make, which is that the figure is
  // INSIDE ITS OWN BEAT rather than pinned at a row's nominal value. What makes the
  // apparition faint is no longer a low alpha — pass 1's lighter fog put a 0.3-alpha
  // near-black body at 0.90 of its own background, where §12.1's hole is 0.62, and no
  // amount of fog fixed that — it is the fog at ninety metres plus a body that keeps
  // moving. So the body column moved up (0.78) and the beat stayed, and this check
  // holds the beat rather than the number it used to restate.
  let beatLow = Infinity
  let beatHigh = 0
  for (let t = 0; t < 4; t += 1 / 240) {
    const value = beast.creaturePose({ state: 'telegraph' }, { time: t, distance: 90 }).presence
    beatLow = Math.min(beatLow, value)
    beatHigh = Math.max(beatHigh, value)
  }
  const onScreen = game.creatureView.pose.presence
  assert.ok(
    onScreen > beatLow - 1e-9 && onScreen <= beatHigh + 1e-9,
    `the apparition's body is at ${onScreen}, which is outside the range its own beat produces ` +
      `(${beatLow.toFixed(3)}-${beatHigh.toFixed(3)})`,
  )
  assert.ok(
    beatHigh - beatLow > 0.05,
    "the telegraph row's body beat is flat, so the title screen is showing a solid figure and calling it an apparition",
  )
  // ...and it is still an apparition: a title screen with a solid figure on it is a
  // different game, and the beat is what makes it one
  assert.ok(
    game.creatureView.pose.eye > 0,
    'the apparition is on the title screen with its eye at zero, so there is nothing to notice',
  )
  // §8.3's distance floor is also the telegraph's, so the eyes are at their
  // largest here — the pixel floor, not an anatomical eye
  assert.ok(game.creatureView.pose.eyeSize > 1, 'the eyes hold the pixel floor at that range')
  // SLICE 14: §6.1 says the sighting "appears at long range", and until this fix
  // the world placed it at *zero* — `_firstSightingPoint` tested the view cone
  // against canonical node positions in a wrapped world, found nothing, and fell
  // back to the spawn point itself. A telegraph at distance 0 is not a sighting,
  // and because `inSightCone` is trivially true at zero it could never end: the
  // Act I apparition was on screen for the whole of Act I, permanently. The
  // distance floor is §8.3's, read in metres.
  //
  // Measured through `worldOfNear`, because that is the frame the world measures
  // in and the two are 32 m out of step (§3.3's seam). Measuring the canonical
  // number here would be a check that disagrees with the code it checks.
  const floor = hood.BLOCK * Math.SQRT2 * beast.REEMERGE_MIN_GRAPH_DISTANCE
  const rangeOf = (canonical) => {
    const folded = game.streetView.worldOfNear(canonical, hood.SPAWN.position)
    return Math.hypot(folded.x - hood.SPAWN.position.x, folded.z - hood.SPAWN.position.z)
  }
  const opened = rangeOf(game.creaturePosition)
  assert.ok(opened >= floor, `§6.1's sighting stands ${opened.toFixed(1)} m away, not "long range"`)
  // ...and for EVERY seed, not just 1337. The sighting is a hashed pick out of a
  // pool of seven in-cone nodes and the closest of those is 5.7 m, so the floor is
  // load-bearing for some seeds while the default run happens to land on a far
  // one. A guard only one seed exercises is a guard with one chance, and this one
  // survived mutation testing on exactly that basis.
  const seed = game.seed
  for (let s = 1; s <= 8; s += 1) {
    game.seed = s
    const range = rangeOf(game._firstSightingPoint())
    assert.ok(range >= floor, `seed ${s} put §6.1's sighting at ${range.toFixed(1)} m`)
  }
  game.seed = seed
})

check('the Act I sighting ends when the player looks back (§6.1)', () => {
  // §6.1: "it appears at long range and is gone when you look back". The second
  // half of that sentence is a claim about the *player's* action, so the check has
  // to perform it. Four seconds of standing still facing the apparition is not
  // looking back, and a world that ended the sighting on that clock would be
  // inventing a timer the design does not have.
  game.restart()
  run(game, 1.6)
  game.start()
  assert.equal(game.creature.state, 'telegraph', 'Act I opens as a sighting')
  run(game, 4)
  assert.equal(game.creature.state, 'telegraph', '§6.1: it stays while you are looking at it')
  assert.equal(game.creatureView.root.visible, true, 'and it is on screen the whole time')
  game.player.teleport(game.player.pos.x, game.player.pos.z, game.player.yaw + Math.PI)
  run(game, DT * 2)
  assert.equal(game.creature.state, 'dormant', '§6.1: gone when you look back')
  assert.equal(game.creatureView.root.visible, false, 'and it stops being drawn')
  // §6.1's other half: it was never a hunter. Act I is frightening and never unfair.
  assert.equal(game.creature.awareness, 0, '§8.1: it perceives nothing')
  assert.equal(game.state.hammerHeld, false, 'and the pickup never happened')
})

check('the opening beats arrive in one order: control and sighting first, the dissolve after', () => {
  // ITERATION 2, PASS 19 — the first-30s pacing gate, in the form the pass-18
  // review said was the only honest one available without a design decision.
  //
  // WHAT THE REVIEW ASKED FOR, AND WHAT THIS IS INSTEAD
  // -----------------------------------------------------
  // REVIEW-pass-18's NOT-DONE section wanted "the gap between consecutive
  // fire-and-forget presentation beats must stay under the §6 number", and said
  // plainly why it had not written it: the number encodes an answer to a pacing
  // question this pass is not entitled to answer. It measured the standing-still
  // case at a 1.40 s longest silence and the walking-forward case at 15.93 s, and
  // then declined to pick between "a deliberate silence" and "a defect".
  //
  // So this gate asserts the ORDER and no durations at all. An order is a
  // property of the world; a duration is a property of a design the design has
  // not written down. The three beats below are the ones §6.1 and §9.3 already
  // name, and the claim is only that they happen in this order on the way in:
  //
  //   1. THE DISSOLVE. `start()` puts `fade` back to 1 and the phase to PLAYING
  //      on the same call, so the hand-off from the title card is a fade-out
  //      rather than a cut, and it is LIFTING on the first frame of PLAYING.
  //   2. THE CONTROL. The player is enabled by the same call, so the world is
  //      taking input while it is still black — the input is not gated behind
  //      the dissolve finishing.
  //   3. THE SIGHTING. The creature is `telegraph` and on screen, and it is on
  //      screen on the FIRST frame the player could act, not after a scripted
  //      wait. This is the beat the review measured at 0.02 s.
  //
  // Those are numbered as the three things being checked, NOT as a sequence —
  // the sequence is the next paragraph, and the numbering is the exact thing
  // that misled this check's own name before (see the M3 note below).
  //
  // The order the world actually runs is CONTROL -> SIGHTING -> DISSOLVE, and
  // that is the assertion: the player can act and there is something to act
  // about on the same frame, and the picture finishes afterwards. Measured, all
  // three first read true on the SAME frame, so what "order" means here is
  // stated as a relation between frames further down rather than as a sequence
  // of three events. The reviewer's instinct that a fade which has to complete
  // before the world speaks is a cut wearing a fade as a disguise is the whole of
  // the claim.
  //
  // Every one of those three is checkable without a threshold, which is the
  // whole reason this gate can exist. What it deliberately does NOT say is how
  // long the silence after beat 3 may be; that number is still unmade, and the
  // measured 15.93 s walking-forward stretch is still debt.
  //
  // MUTATIONS, because a gate nobody has tried to fool is a gate nobody knows.
  // Three were run against this check, each applied and reverted, each on the
  // real harness:
  //   M1  hold the control until after the first update      -> RED, the dissolve assert
  //   M2  a scripted delay between "you can act" and the sighting
  //                                                          -> RED, by name
  //   M3  swap ONLY the expected order, world untouched     -> RED, and the
  //       failure message prints the order it actually saw.
  //
  // M3 WAS SUPPOSED TO BE THE ONE THAT MATTERS — "the three facts above are also
  // each asserted on their own, so a gate that only had them would have gone green
  // on a world that satisfied every one of them and none of them in sequence."
  // IT IS NOT, AND THE PASS-19 REVIEW RE-RAN IT AND MEASURED WHY. M3 goes red
  // because the array literal changed, which proves the comparison is wired up
  // and nothing else. The order it compared was not the world's: all three beats
  // are true on the SAME frame (measured — control, sighting and dissolve all
  // first read true at frame 0), so the loop broke on its first iteration and
  // `seen` was the order this file's three `if` statements are written in. The
  // ordering assertion has been rewritten as a frame relation below, which is the
  // version of M3 that would mean something: mutate the world to delay the
  // sighting and the gate goes red on the ORDER, not only on the three facts.
  // The M3 record is kept rather than deleted, because "M3 caught it" is exactly
  // the sentence a future pass would otherwise have taken at face value.
  //
  // WHY IT IS NOT IN verify.mjs: this is a property of the BUILT world — it
  // reads `game.fade`, `game.player.enabled` and the creature view's own `pose`,
  // none of which the pure harness can import (§15.1's seam). It is the same
  // reason §6.1's sighting and §8.2's phase-out are here and not in the other
  // file.
  //
  // AND WHY IT BUILDS ITS OWN WORLDS. The preconditions below are about the TITLE
  // card — the player frozen, nothing on screen — and `restart()` cannot produce
  // them: §10.4's BEGIN AGAIN is a new *begun* run, so it leaves the player
  // enabled and puts the sighting back. Reaching for `restart()` here would have
  // asserted the preconditions against a run that had already started, which is
  // the same class of mistake the pass-18 review found in the "gone when you look
  // back" check before it. A throwaway mount is the honest way to ask what the
  // world looks like before anyone presses BEGIN.
  const opening = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  assert.equal(opening.player.enabled, false, 'the player is not frozen behind the start overlay, so the control claim below is vacuous')
  assert.equal(opening.creature.state, 'telegraph', 'Act I did not open as a sighting, so the sighting claim below is vacuous')
  assert.equal(opening.creatureView.root.visible, false, 'and the sighting is already on the title card, so the order below is not an order')

  opening.start()
  // 1. the dissolve is standing AND lifting: not a cut, and not a black screen
  //    left standing while the run is already playable
  assert.equal(opening.fade, 1, 'the hand-off from the title card is a cut, not a dissolve')
  assert.equal(opening.player.enabled, true, 'and BEGIN did not hand over control')
  opening.update(DT)
  assert.ok(
    opening.fade > 0 && opening.fade < 1,
    `the fade is ${opening.fade} on the first frame of PLAYING; it is either a cut (0) or a lid nobody is lifting (1)`,
  )
  // 2. the control is live *while* the dissolve is still running, which is the
  //    ordering claim: input is not gated behind the picture being finished
  assert.equal(opening.player.enabled, true, 'the player is frozen until the dissolve finishes')
  // 3. the sighting is on screen on the same first frame — no scripted delay
  //    between "you can act" and "there is something to act about"
  assert.equal(opening.creature.state, 'telegraph', 'Act I does not open as a sighting')
  assert.equal(opening.creatureView.root.visible, true, 'and the first frame the player can act on has nothing on screen')
  const pose = opening.creatureView.pose
  assert.equal(pose.present, true, 'so the creature view is not presenting a figure either')
  assert.ok(pose.presence > 0, `and it is drawn at presence ${pose.presence} — present but invisible is not a beat`)

  // ...and the ORDER, read as an order rather than as three separate truths. A
  // world that satisfied each of the three above on some frame of the first
  // second, in a different order, would pass none of this. The order is the
  // claim; the three facts are how it is stated.
  //
  // It is a SECOND world rather than a rewind of the first, because the first
  // has already been stepped and "when did control arrive" is not a question a
  // world can answer twice.
  //
  // PASS 19 REVIEW: this used to collect the beats into a `seen` array and
  // `deepEqual` it against `['control', 'sighting', 'dissolve']`, which is the
  // shape the pass's own M3 mutation proved only that the literal was compared.
  // It cannot see an order, and here is why: the three beats are ALL true on the
  // first frame of PLAYING (measured: control, sighting and dissolve all first
  // read true at frame 0), so the loop breaks on its first iteration and `seen`
  // is simply the order the three `if` statements happen to be written in — a
  // property of this file, not of the world. On top of that the array form
  // tolerates a world that hands the player control ten frames BEFORE there is
  // anything to act about, because that world still pushes 'control' first.
  //
  // So the order is recorded as the FRAME each beat first reads true, and
  // asserted as a relation between frames. Frame indices are the one reading a
  // same-frame world cannot fake by reordering statements, and the two relations
  // below are strictly tighter than the array they replace: equality on the
  // first, and a lower bound on the second.
  //
  // `cleared` rides in the same loop on purpose: the dissolve's own duration is
  // then a MEASUREMENT off the world rather than a second copy of
  // `FADE_LIFT_PER_SECOND`, which the pass's print used to hardcode as `(1 / 0.7)`.
  // A print whose whole job is to keep a debt re-measurable cannot be the thing
  // that goes stale when the constant it copied is retuned. The 1.50 s window is
  // reported as itself if the fade ever outlasts it.
  const ordered = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  ordered.start()
  const at = { control: null, sighting: null, dissolve: null, cleared: null }
  for (let i = 0; i < 90; i += 1) {
    ordered.update(DT)
    if (at.control === null && ordered.player.enabled) at.control = i
    if (at.sighting === null && ordered.creatureView.root.visible) at.sighting = i
    if (at.dissolve === null && ordered.fade < 1) at.dissolve = i
    if (at.cleared === null && ordered.fade === 0) at.cleared = i
  }
  const frame = (k) => (at[k] === null ? 'never' : `frame ${at[k]} (${(at[k] * DT).toFixed(3)} s)`)
  assert.ok(
    at.control !== null && at.sighting !== null && at.dissolve !== null,
    `the opening never produced all three beats inside the first ${(90 * DT).toFixed(2)} s — control at ${frame('control')}, sighting at ${frame('sighting')}, dissolve at ${frame('dissolve')}`,
  )
  // THE ORDER, as two relations between frames.
  //   1. control and the sighting arrive TOGETHER: there is no frame in which the
  //      player can act and there is nothing to act about.
  //   2. the dissolve is lifting on that frame or later, never before: input is
  //      not gated behind the picture being finished.
  assert.equal(
    at.control,
    at.sighting,
    `the player had control from ${frame('control')} and the sighting from ${frame('sighting')}; the contract is that they arrive on the same frame — the first frame of PLAYING — because a delay between "you can act" and "there is something to act about" is a scripted wait wearing an order as a disguise`,
  )
  assert.ok(
    at.dissolve >= at.control,
    `the dissolve started lifting at ${frame('dissolve')} but the player had control from ${frame('control')}; the picture being finished before the world takes input is a cut wearing a fade as a disguise`,
  )
  // The review's measured figures, re-measured here so the debt this gate does
  // NOT close stays attached to a number rather than to a review nobody re-reads.
  // Standing still, the sighting never ends — §6.1's "gone when you look back"
  // is a claim about the player's action, and the check above performs it. So the
  // 30 s the review measured is spent, and it is quiet for all of it, and that is
  // the design's answer rather than this gate's.
  run(ordered, 30)
  assert.equal(
    ordered.creature.state,
    'telegraph',
    'a standing player lost the sighting in 30 s; §6.1 ends it on looking back, not on a clock, and this gate has just started inventing one',
  )
  // ...and the walking-forward case the review measured at a 15.93 s silent
  // stretch, reproduced so the number in the review is a number somebody can
  // re-derive. It is NOT asserted against — the threshold is the design decision
  // this gate declines to make — but it is printed, because a debt nobody can
  // re-measure is a debt that quietly stops being true.
  const walker = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  walker.start()
  walker.player.pressKey('KeyW')
  let leftAt = null
  for (let i = 0; i < Math.ceil(30 / DT); i += 1) {
    walker.update(DT)
    if (leftAt === null && walker.creature.state !== 'telegraph') leftAt = walker.animTime
  }
  walker.player.releaseKey('KeyW')
  const order = ['control', 'sighting', 'dissolve'].sort((a, b) => at[a] - at[b])
  console.log(
    `\n  opening beats, by the frame each first reads true: ${order.map((k) => `${k} @ ${frame(k)}`).join(', ')}` +
      ` — the review measured them at 0.02 / 0.02 / 1.42 s, and the frame the player can act on is the frame the picture is still lifting;` +
      ` the dissolve clears at frame ${at.cleared} (${at.cleared === null ? 'not within the 1.50 s window' : `${(at.cleared * DT).toFixed(2)} s`}), and a player who walks forward from the spawn loses the sighting at ` +
      `${leftAt === null ? 'never within 30 s' : `${leftAt.toFixed(2)} s`} — the unmade pacing number, measured, not gated`,
  )
  opening.dispose()
  ordered.dispose()
  walker.dispose()
})

check('the awakening toll moves TELEGRAPH -> STALK on pickup and not before', () => {
  // §7.2. The pickup is the only door into Act II, and it is a one-shot.
  //
  // Driven from the *telegraph*, which is the state §6.1's table names
  // (`telegraph -> stalk, "the hammer pickup tolls"`). It cannot be driven from
  // `dormant`, and that is not a gap: a creature whose sighting has already ended
  // is coming back on §8.3's own clock, so a pickup landing in that window has
  // nothing to promote. The check above ends Act I deliberately; this one is about
  // the edge, so it opens Act I again and takes the hammer while the sighting is
  // still live.
  game.restart()
  run(game, 1.6)
  game.start()
  assert.equal(game.creature.state, 'telegraph', 'Act I opens as a telegraph')
  game._takeHammer()
  run(game, DT * 2)
  assert.equal(game.creature.state, 'stalk', '§7.2: the toll is the awakening')
  assert.equal(game._takeHammer(), false, 'and it cannot toll twice')
  run(game, 1)
  assert.equal(game.creature.state, 'stalk', 'a second pickup changes nothing')
})

check('a connected swing banishes, recoils, and advances the §7.4 ladder', () => {
  // §7.4. This is the check that matters most in the list: until slice 10 the
  // world consumed the LMB edge and never handed it to `creatureStep`, so the
  // hammer rang and nothing ever answered.
  placeCreature(game, 2)
  // `awakened` because this is Act II: §7.2's toll has rung, and the re-emergence
  // this check is about is the one that has to happen
  game.creature = beast.createCreature({ state: 'stalk', banishCount: game.state.banishCount, awakened: true })
  assert.equal(game.state.banishCount, 0)
  game._swingPending = true
  game.update(DT)
  assert.equal(game.creature.state, 'stagger', 'a connected swing is a recoil')
  assert.equal(game.state.banishCount, 1, 'the ladder advanced')
  assert.equal(game.creature.banishCount, 1, 'and the run-level mirror agrees')
  // the recoil is drawn, from the §7.4 clock, backwards
  assert.ok(game.creatureView.pose.push > 0, 'the figure is thrown back')
  assert.ok(game.creatureView.pose.pitch < 0, 'and pitched away from the player')
  // and a swing at nothing moves no rung
  game._swingPending = true
  game.update(DT)
  assert.equal(game.state.banishCount, 1, 'a swing at the dark buys nothing')
})

check('a banish removes the creature for its window, draws the departure, and returns it angrier', () => {
  const window0 = beast.banishWindow(game.creature)
  run(game, beast.STAGGER_SECONDS + 0.1)
  assert.equal(game.creature.state, 'dormant', 'the recoil completes into a removal')
  assert.equal(game.dismissing, true, 'and the departure is drawn')
  run(game, beast.FADE_SECONDS.dismiss + 0.1)
  assert.equal(game.dismissing, false, 'the dismissal window is finite')
  assert.equal(game.creatureView.root.visible, false, 'and then it is gone')
  const before = beast.creatureSpeed(game.creature.tier, game.creature.reemergenceCount)
  // §8.3's arrival is drawn, not snapped: watch it come in from nothing
  let arrival = null
  for (let i = 0; i < Math.ceil((window0 + 1) / DT) && arrival === null; i++) {
    game.update(DT)
    if (game.creature.state === 'stalk' && game.creature.reemergenceCount > 0) {
      arrival = game.creatureView.pose
      assert.ok(arrival.presence < 0.2, `the arrival is drawn at ${arrival.presence.toFixed(3)}, not faded in`)
    }
  }
  assert.ok(arrival, 'the creature never came back')
  // §8.1, the other half of the awakening: a creature that never took the hammer
  // is not re-offered anything, ever. This is the world-level statement of the rule
  // the balance simulation found broken — the reckless Act I player was caught
  // sixteen times in a phase that cannot kill you — and it is a property of the
  // state machine rather than a branch somewhere in the world, so the pure check in
  // `verify.mjs` can hold it too.
  const asleep = beast.createCreature({ state: 'telegraph' })
  const dismissed = beast.creatureStep(asleep, DT, { sighting: false, distance: 60, sounds: [] })
  assert.equal(dismissed.to, 'dormant')
  const refused = beast.creatureStep(dismissed.creature, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(refused.to, 'dormant', '§8.1: Act I cannot kill you, and Act I cannot chase you either')
  assert.ok(beast.creatureSpeed(game.creature.tier, game.creature.reemergenceCount) > before, 're-emergence is angrier')
  assert.equal(game.creature.lastHeard, null, 'and it comes back knowing nothing')
  run(game, beast.FADE_SECONDS.reemerge + 0.1)
  assert.ok(game.creatureView.pose.presence > 0.5, 'and it arrives')
  // §8.3 on the placement the world actually made
  const spot = game.creaturePosition
  const hops = hood.streetDistanceMap(beast.nodeId({ x: game.player.pos.x, z: game.player.pos.z }))
  assert.ok(hops[beast.nodeId(spot)] >= beast.REEMERGE_MIN_GRAPH_DISTANCE, 'minimum graph distance')
  assert.equal(beast.lineOfSight({ x: game.player.pos.x, z: game.player.pos.z }, spot, game.streetView.canonicalOccluders()), false, 'never in line of sight')
})

check('a CHASE past CHASE_MAX_SECONDS phase-outs, and the phase-out is drawn', () => {
  // §8.2, and the most important rule in the anti-frustration section.
  game.creature = beast.createCreature({ state: 'chase', awareness: 1, chaseSeconds: beast.CHASE_MAX_SECONDS - DT / 2 })
  const banishesBefore = game.state.banishCount
  placeCreature(game, 30)
  game.update(DT)
  assert.equal(game.creature.state, 'dormant', 'the clock fired')
  assert.equal(game.dismissing, true, 'and the departure is drawn')
  assert.equal(game.creature.chaseSeconds, 0)
  assert.equal(game.creature.awareness, 0, '§8.3: it goes knowing nothing')
  // and it earns nothing: a chase that ran out of clock is not a banish
  //
  // SLICE 14: this was `assert.equal(game.state.banishCount, 0)`, and it was
  // wrong twice. It asserted an absolute, in a suite where the check above it had
  // already advanced the ladder to 1 — so it was really asserting "the previous
  // check tidied up after itself", which is a property of the file, not of the
  // game. §9.2's claim is comparative: *this* phase-out advanced nothing. Read
  // against the count as it stood on the way in, it says what the design says and
  // it says it whether the ladder is at 0 or at 4.
  assert.equal(
    game.state.banishCount,
    banishesBefore,
    '§9.2: a chase that ran out of clock is not a banish',
  )
  assert.equal(game.creature.banishCount, banishesBefore, 'and the creature agrees')
})

check('a capture resets the player to spawn, permutes the fixtures, and keeps progress', () => {
  // §9.1, §3.6 and §3.7 together, on the wired world rather than on the reducer.
  game.state = { ...game.state, hammerHeld: true, banishCount: 3, portals: { A: true, B: true, C: false } }
  game.streetView.setPortalShut('A', true)
  game.streetView.setPortalShut('B', true)
  const loopBefore = game.state.loop
  const duskBefore = game.state.dusk
  const dressing = hood.fixtureSignature(hood.fixturePass(1337, game.state.loop))
  game.player.teleport(game.player.pos.x + 40, game.player.pos.z + 40, 0)
  game.creature = beast.createCreature({ state: 'chase', awareness: 1, banishCount: 3 })
  placeCreature(game, 0)
  game.update(DT)
  assert.equal(store.get().phase, PHASE.RESET, 'a capture resets')
  // §9.3: the creature reset happens behind the black, so nothing is drawn on the
  // capture frame itself — this is the assertion that caught the stale phase read
  assert.equal(game.creatureView.root.visible, false, 'the creature is removed on the frame it catches you')
  assert.equal(game.state.loop, loopBefore + 1, 'the capture counter advanced')
  assert.equal(game.state.banishCount, 3, '§9.1: the banish ladder survives')
  assert.deepEqual(game.state.portals, { A: true, B: true, C: false }, '§9.1: the portals survive')
  assert.equal(game.state.hammerHeld, true, '§9.1: the hammer survives')
  assert.equal(game.state.dusk, duskBefore, '§3.7: dusk tracks portals, not the loop')
  assert.equal(game.creature.reemergenceCount, 0, '§9.1: the pressure axis is the thing that resets')
  assert.equal(game.creature.state, 'stalk', 'back to Act II, not Act I')
  assert.ok(Math.hypot(game.player.pos.x - hood.SPAWN.position.x, game.player.pos.z - hood.SPAWN.position.z) < 0.01, 'and the player is at spawn')
  assert.notEqual(hood.fixtureSignature(hood.fixturePass(1337, game.state.loop)), dressing, '§3.6: the dressing permutes')
  run(game, 0.2)
  assert.equal(game.creatureView.root.visible, false, 'nothing is drawn behind the black')
  run(game, 2.0)
  assert.equal(store.get().phase, PHASE.PLAYING, 'and play resumes')
})

// ---------------------------------------------------------------------------
// iteration 2, pass 1 — the sodium retune, measured on the live lights
// ---------------------------------------------------------------------------

/**
 * Rec. 709 relative luminance of a Three.js colour, 0-255, *in sRGB*.
 *
 * The conversion is the whole point of this helper. Three.js stores a `Color`'s
 * components in the linear working space, so `fog.color.r` for #332a1c is 0.033,
 * not 0.200 — and taking a luminance straight off those numbers reports 6 luma
 * for a fog that `streetView.js` and §12.3 both call a 43. It is the same colour;
 * it is just written down in the units the renderer will encode it in later, and
 * a gate that compares across those two units is a gate measuring nothing.
 */
function lumaOf(color) {
  const encode = (linear) => {
    const c = Math.max(0, Math.min(1, linear))
    return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255
  }
  return 0.2126 * encode(color.r) + 0.7152 * encode(color.g) + 0.0722 * encode(color.b)
}

/** How warm a colour is: how far its green sits between its red and its blue. */
function warmth(color) {
  const encode = (linear) => {
    const c = Math.max(0, Math.min(1, linear))
    return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  }
  const r = encode(color.r) * 255
  const g = encode(color.g) * 255
  const b = encode(color.b) * 255
  return { r, g, b, ratio: g / r, spread: r - b }
}

check('the world is lit, and what lights it is sodium', () => {
  // The counterpart to `verify.mjs`'s source-level section, and it exists because
  // a source grep cannot see a *rendered* light. Every number asserted there is a
  // claim about the text of `world.js`; this one is a claim about the `THREE.Light`
  // objects the game actually puts in its scene after `_applyDusk`.
  //
  // The bug class it is aimed at is specific: a hemisphere whose colour was never
  // set (so it renders white, and the sodium street goes grey), a fog whose
  // `background` was left as a different colour than its `color` (so the horizon
  // line the fog is supposed to hide becomes visible), and a dusk curve whose
  // falloff cancels the palette's own rise. All three pass a source grep.
  game.restart()
  run(game, 1.2)

  const readings = [0, 0.5, 1].map((dusk) => {
    game._applyDusk(dusk)
    return {
      dusk,
      exposure: game.renderer.toneMappingExposure,
      ambient: game.hemisphere.intensity,
      key: game.sunset.intensity,
      sky: game.hemisphere.color.clone(),
      fog: game.scene.fog.color.clone(),
    }
  })

  // §12.1: "dusk, not night" is a claim about the frame, so it is checked as one.
  // The brief for this pass asked for a *lighter* world than shipped, and the
  // numbers the pure gate reads out of the source are only meaningful if the
  // lights they configure are the ones the renderer uses.
  for (const reading of readings) {
    assert.ok(reading.exposure > 0.85, `dusk ${reading.dusk}: exposure is ${reading.exposure.toFixed(3)} — the frame is being crushed`)
    assert.ok(reading.exposure <= 1.15, `dusk ${reading.dusk}: exposure is ${reading.exposure.toFixed(3)}, which is day`)
    assert.ok(reading.ambient >= 0.6, `dusk ${reading.dusk}: ambient is ${reading.ambient.toFixed(2)} — the world has no floor under it`)
  }

  // and it is *sodium*, not merely bright. A warm ramp is a hue claim and hue is
  // the thing a luma check cannot see: a white hemisphere at the same intensity
  // satisfies every brightness assertion above and still delivers a grey street.
  for (const reading of readings) {
    for (const [name, color] of [['sky', reading.sky], ['fog', reading.fog]]) {
      const { r, g, b, spread } = warmth(color)
      assert.ok(r > g, `dusk ${reading.dusk}: the ${name} light is not red-dominant (${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`)
      assert.ok(g > b, `dusk ${reading.dusk}: the ${name} light is not amber (${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`)
      assert.ok(spread > 0.1, `dusk ${reading.dusk}: the ${name} light is grey, not sodium`)
    }
  }

  // the fog and the background are the same colour, which is the trick the whole
  // fogged-horizon look rests on (§12.1) and the easiest thing in the file to
  // break by assigning one and forgetting the other.
  assert.equal(
    game.scene.background.getHex(),
    game.scene.fog.color.getHex(),
    'the background and the fog are different colours, so the horizon draws a hard line',
  )

  // §3.7: the world still closes. Fog luma has to fall across a run or dusk is
  // not a clock any more, and the ambient has to fall with it or the *sky* closes
  // while the light on the street does not.
  const fogLum = readings.map((reading) => lumaOf(reading.fog))
  assert.ok(fogLum[0] > fogLum[2], `the fog does not darken across a run: ${fogLum.map((v) => v.toFixed(0)).join(' -> ')}`)
  assert.ok(
    readings[0].ambient > readings[2].ambient,
    'the ambient light does not fall with dusk, so §3.7 has no clock left',
  )
  // and the darkest frame is still a *lit* frame — the "too dark to see things"
  // complaint, restated as a bound rather than as a hope.
  assert.ok(fogLum[2] > 35, `dusk 1 fog is ${fogLum[2].toFixed(0)} luma — the finale is a black frame`)

  // the mid stop is the crest, on the live colours and not only in the source:
  // the middle of a run is brighter than the start, which is what makes the sky
  // read as a lit overcast rather than a flat wash.
  assert.ok(fogLum[1] > fogLum[0], 'the mid-dusk fog is not the brightest of the three')

  // the key light is warm too, and it is what lifts the rooflines out of the fog
  const key = warmth(game.sunset.color)
  assert.ok(key.r > key.b, `the horizon key is ${game.sunset.color.getHexString()}, which is cold against a sodium sky`)

  // put the world back the way the checks below it expect to find it
  game._applyDusk(game.state.dusk)
})


check('a capture on its own removes the figure, with no frame around it', () => {
  // `_capture` is self-contained. Inside `update` the next `_updateCreatureView`
  // would hide the figure anyway, so this is belt-and-braces — but it is the
  // difference between "a capture removes the creature" and "a capture removes the
  // creature, provided something else runs first", and §9.3 is a rule, not a race.
  game.restart()
  run(game, 1.6)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.creatureView.root.visible, true, 'the Act I apparition is on screen')
  game._capture()
  assert.equal(game.creatureView.root.visible, false, 'and a capture takes it away by itself')
  assert.equal(game.dismissing, false, 'with no dismissal drawn for it')
})

check('the creature is drawn in the copy the player is standing in', () => {
  // §3.3's fold, for the creature. The position is canonical and everything drawn
  // is not; if the view drew the canonical position the figure would jump a whole
  // world period every time the street slid.
  game.restart()
  run(game, 1.6)
  // SLICE 14: this was `assert.deepEqual(root.position, { x, z })`, and it could
  // never pass. `root.position` is a `THREE.Vector3`, not a plain object, so
  // `deepEqual` was comparing a class instance with a literal — and the failure it
  // reported ("+ Vector3 { - {") said nothing about the fold, which was correct
  // all along. The claim is about two coordinates, so it is asserted as two
  // coordinates.
  const drawn = game.creatureView.root.position
  assert.equal(
    drawn.x,
    game.creaturePosition.x + game.streetView.origin.x,
    'the drawn x is the canonical one, folded into the drawn copy',
  )
  assert.equal(
    drawn.z,
    game.creaturePosition.z + game.streetView.origin.z,
    'and so is the drawn z',
  )
  // The wrap half needs a figure that is actually *being drawn*, because
  // `CreatureView.present` returns before it touches `root.position` when there is
  // nothing to show. An Act I sighting the player has looked away from draws
  // nothing, so the assertion would be reading a position left over from a frame
  // that is long gone — and it did, which is why the first version of this check
  // reported "never a whole period away" for a figure that was not on screen.
  //
  // And the placement has to be CANONICAL, like every other one in the game
  // (`reemergeNode` and `_firstSightingPoint` both write canonical values). The
  // player's position is *not* canonical — the player never wraps, the world does
  // — so `player.pos + 40` is a world coordinate being stored in a canonical
  // field, and the fold then carries it a whole `origin` away from where the
  // check meant to put it. The distance arithmetic hides that, because
  // `wrapDelta` folds the difference back; the *drawing* does not, and the drawing
  // is what this check is about. So the canonical player is derived here the same
  // way the world derives it: world minus origin.
  game.state = { ...game.state, hammerHeld: true }
  game.creature = beast.createCreature({ state: 'stalk' })
  placeCreature(game, 40)
  game.update(DT)
  assert.equal(game.creatureView.root.visible, true, 'the Act II figure is on screen')
  assert.ok(
    Math.hypot(
      game.creatureView.root.position.x - game.player.pos.x,
      game.creatureView.root.position.z - game.player.pos.z,
    ) > 20,
    'and it is drawn at the range it was placed at, not a whole period away',
  )
  game.player.teleport(game.player.pos.x + hood.WORLD_EXTENT, game.player.pos.z, 0)
  game.update(DT)
  const afterWrap = game.creatureView.root.position
  assert.ok(
    Math.hypot(afterWrap.x - game.player.pos.x, afterWrap.z - game.player.pos.z) < 80,
    `the figure is ${Math.hypot(afterWrap.x - game.player.pos.x, afterWrap.z - game.player.pos.z).toFixed(1)} m from a player 40 m away`,
  )
  // and it is the canonical position in the *new* copy, not the old one
  assert.equal(afterWrap.x, game.creaturePosition.x + game.streetView.origin.x)
  assert.equal(afterWrap.z, game.creaturePosition.z + game.streetView.origin.z)
})

check('the finale enrages the creature and the figure is reddened', () => {
  // §10.2. The reddening is the finale's visible consequence, and it is applied in
  // `creatureView.js` from the pure `redden` factor, so this is the only place the
  // hex is checked.
  game.state = { ...game.state, finale: true }
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.5, finale: true })
  placeCreature(game, 8)
  game.update(DT)
  assert.equal(game.creature.state, 'enraged', '§10.2')
  assert.equal(game.creatureView.pose.redden, 1)
  assert.ok(game.creatureView.pose.presence > 0.9, 'the enraged figure is at full presence')
  assert.notEqual(game.creatureView.bodyMaterial.color.getHexString(), '08070a', 'and is no longer the near-black silhouette')
  assert.notEqual(game.creatureView.eyeMaterial.color.getHexString(), 'cfe0ff', 'with hotter eyes')
})

// The `dispose()` check that was here moved to the bottom of the file, with the
// v1 block's: it frees the world every block below this line drives. Its note that
// it "needs `document.removeEventListener` on the stub" is satisfied — the stub
// above has it, and `player.dispose()` is what reaches for it.

// ---------------------------------------------------------------------------
// slice 11 — the audio, driven through the real world
// ---------------------------------------------------------------------------
//
// Transcribed from a working run rather than sketched, like the block above, and
// parked for the same reason. `makeFakeAudio` records `update` and replays
// the frame through the real `routeAudio`, so each of these is an assertion about
// what the *player* would have heard on a real frame of the real world — which is
// the only thing a world check can say about audio.
//
// All seven landed as written. The prediction in the old header — that
// `dispose()` here would find "an earlier check in this file has already disposed
// the first one" — was describing a bug, not a fact: the earlier `dispose()` was
// v1's, in the block above, and slice 14 moved it to the bottom. This one already
// built a second world, which is why it survived the move untouched.

check('the world makes one audio call per frame, and it is the router', () => {
  // `restart()` legitimately rings the reset sting (§13: a wipe is a capture in
  // everything but name), so the clean playing frame is what is under test here
  game.restart()
  run(game, 1.6)
  audio.calls.length = 0
  run(game, 0.5)
  assert.ok(audio.calls.includes('update'), 'the router was never called')
  assert.equal(
    audio.calls.filter((name) => name === 'update').length,
    Math.round(0.5 / DT),
    'the router is not called exactly once per frame',
  )
  // a quiet frame in a quiet street: no stride, no swing, no shutdown, no capture.
  // §13's opening toll is gone too — it was the world's clock, and v2 has none.
  for (const id of ['awakening', 'banish', 'whiff', 'reset', 'portalShutdown']) {
    assert.equal(audio.calls.includes(id), false, `a quiet frame rang ${id}`)
  }
  // the drone and the readouts are routed on every one of those frames, which is
  // what stops a voice being left running by a frame that forgot to mention it
  assert.ok(audio.calls.includes('drone'))
  assert.ok(audio.calls.includes('breath'))
  assert.ok(audio.calls.includes('portalHum'))
})

check('a swing that connects tolls, and a swing at nothing does not', () => {
  game.restart()
  run(game, 1.6)
  game.state = { ...game.state, hammerHeld: true }
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  placeCreature(game, 1)
  audio.calls.length = 0
  game.player.pressButton(0)
  game.update(DT)
  game.player.releaseButton(0)
  assert.ok(audio.calls.includes('banish'), 'a connected swing did not toll')
  assert.equal(audio.calls.includes('whiff'), false, 'and it also whiffed')
  assert.equal(game.state.banishCount, 1, '§7.4: the ladder advanced')
  // and the same swing, out of reach, is a whiff and no toll
  run(game, beast.STAGGER_SECONDS + 0.2)
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  placeCreature(game, beast.BANISH_RANGE + 2)
  audio.calls.length = 0
  game.player.pressButton(0)
  game.update(DT)
  game.player.releaseButton(0)
  assert.ok(audio.calls.includes('whiff'), 'a miss was silent')
  assert.equal(audio.calls.includes('banish'), false, 'a miss rang the banish toll')
  assert.equal(game.state.banishCount, 1, '§7.4: a miss buys nothing')
})

check('the awakening toll fires once on the pickup and never again', () => {
  game.restart()
  run(game, 1.6)
  audio.calls.length = 0
  game._takeHammer()
  game.update(DT)
  assert.ok(audio.calls.includes('awakening'), 'the pickup did not toll')
  assert.equal(audio.calls.filter((name) => name === 'awakening').length, 1, 'it tolled twice in one frame')
  // a capture keeps the hammer (§9.1), and the second pickup cannot ring again
  game._capture()
  run(game, 1.4)
  assert.equal(game.state.hammerHeld, true, '§9.1: the hammer survived the capture')
  audio.calls.length = 0
  assert.equal(game._takeHammer(), false, 'the hammer was picked up twice')
  game.update(DT)
  assert.equal(audio.calls.includes('awakening'), false, 'the toll fired a second time')
})

check('the capture sting is one toll, and nothing else speaks through the black', () => {
  game.restart()
  run(game, 1.6)
  game.state = { ...game.state, hammerHeld: true }
  game.creature = beast.createCreature({ state: 'chase', awareness: 1 })
  placeCreature(game, 0)
  audio.calls.length = 0
  game.update(DT)
  assert.equal(store.get().phase, PHASE.RESET, 'the capture did not reset')
  assert.equal(audio.calls.filter((name) => name === 'reset').length, 1, 'the sting was not exactly one toll')
  // and the whole black: no footsteps (the player is disabled), no breath (not
  // playing), no hums (not playing). §13 gives the capture one sound.
  audio.calls.length = 0
  run(game, 1.0)
  for (const id of ['walk', 'sprint', 'exhausted', 'awakening', 'banish', 'whiff', 'portalShutdown']) {
    assert.equal(audio.calls.includes(id), false, `${id} played during the black`)
  }
  // the hums are still *routed*, just silent, which is what stops a voice being left
  // running by a frame that forgot to mention it
  assert.ok(audio.calls.includes('portalHum'), 'the hums stopped being routed')
})

check('the player only emits footstep sound while really moving', () => {
  game.restart()
  run(game, 1.6)
  audio.calls.length = 0
  run(game, 1.0) // standing still
  assert.equal(audio.calls.includes('walk'), false, 'standing still produced a footstep')
  game.player.pressKey('KeyW')
  run(game, 1.0)
  game.player.releaseKey('KeyW')
  assert.ok(audio.calls.includes('walk'), 'walking produced no footstep at all')
  // and sprinting is the other row, priced by the creature's own table
  audio.calls.length = 0
  game.player.pressKey('KeyW')
  game.player.pressKey('ShiftLeft')
  run(game, 0.6)
  assert.ok(audio.calls.includes('sprint'), 'sprinting produced no sprint tick')
  // the winded gait arrives on its own, without the player asking for it
  game.player.releaseKey('ShiftLeft')
  game.player.releaseKey('KeyW')
  game.player.breath = 0
  game.player.exhausted = true
  audio.calls.length = 0
  game.player.pressKey('KeyW')
  run(game, 1.0)
  game.player.releaseKey('KeyW')
  assert.ok(audio.calls.includes('exhausted'), 'a winded walk sounded like a fresh one')
})

check('a shutdown is a 25 m event and a commitment tell, and the hum follows it down', () => {
  game.restart()
  run(game, 1.6)
  const entry = game.streetView.portals[0]
  const spot = game.streetView.worldOf(entry.position)
  game.player.teleport(spot.x, spot.z, 0)
  // the first half of the hold is free and silent (§5.2), and this is the assertion
  // that the surge has not started either. The hold is a real held key here, not
  // `tryInteract`: the surge is raised inside `_updateVerbs` and only reaches the
  // audio on the frame `update` routes it, so a one-shot helper would prove nothing.
  game.player.pressKey('KeyE')
  audio.calls.length = 0
  run(game, 0.4)
  assert.ok(game.state.progress[entry.id] > 0, 'the hold did not progress')
  assert.equal(audio.calls.includes('portalShutdown'), false, 'the first half of a hold was loud')
  // past the threshold it is loud, once per `SOUND_EVENT_SECONDS` window rather
  // than once per frame — so there are far fewer surges than frames
  audio.calls.length = 0
  const frames = Math.round(1.2 / DT)
  run(game, 1.2)
  game.player.releaseKey('KeyE')
  const surges = audio.calls.filter((name) => name === 'portalShutdown').length
  assert.equal(game.state.portals[entry.id], true, 'the portal did not shut')
  assert.ok(surges > 0, 'the second half of a hold was silent')
  assert.ok(surges < frames / 2, `${surges} surges in ${frames} frames: the event is not windowed`)
  // and shutting it is permanent and silent: §5.3, and no fourth toll
  audio.calls.length = 0
  run(game, 0.5)
  assert.equal(audio.calls.includes('portalShutdown'), false, 'a shut portal is still shouting')
  assert.equal(audio.calls.includes('awakening'), false)
  assert.equal(audio.calls.includes('banish'), false)
})

check('dispose() stops the hums it started', () => {
  // The hums are oscillators the world created and nothing else would ever stop
  // them: the drone belongs to the AudioManager, the hums belong to the world.
  // A *second* world rather than the first, because the first one is what the rest
  // of this file is driving and disposing it here would leave the slice-12 block
  // below running against a freed street.
  const second = new BellLoopGame(container, { store, audio, createRenderer: makeFakeRenderer })
  second.start()
  second.update(DT)
  second.update(DT)
  audio.calls.length = 0
  second.dispose()
  assert.ok(audio.calls.includes('stopPortalHums'), 'the hums outlived the world')
})
// ---------------------------------------------------------------------------
// slice 12 — the HUD mirror, pause, and motion sensitivity
// ---------------------------------------------------------------------------
//
// Nine checks, transcribed from a working run rather than sketched — and unlike
// the two blocks above them, these are the first ones in this file that were
// written *after* the harness was stood up in a scratch copy: the parked
// slice-10/11 blocks were transcribed from runs that only the game's own code
// path had driven, whereas these were run against a real constructed world with
// a 2D context extended far enough for `streetView`'s procedural textures. That
// scratch context is the stub at the top of this file now.
//
// All nine landed as written, which is the strongest evidence in the file for the
// scratch harness having been real: the pause, the lock, the reduced-motion and
// the repaint-budget checks are all things a static read gets wrong.
//
// WHAT THESE COVER, AND WHY IT IS ALL HERE
// ---------------------------------------
// - the sigil state tracking portal state through a capture and a wipe, which is
//   §14.1's "lit" polarity and the one thing in this slice that was genuinely
//   easy to get backwards;
// - the ring closing on *exactly* 1.0, its tick crossing on the same frame as
//   §5.2's sound event, and its 0 -> 1 -> 0 bleed, which is §14.2;
// - pause freezing the creature, the player, every clock in the world, and the
//   held keys — §14.3's "freezes the simulation completely", and the failure the
//   design singles out by name;
// - pointer-lock loss pausing one-way, with the grace window that keeps the
//   pause's own lock release from re-pausing the game;
// - reduced motion suppressing the head bob, the camera shake (on *both* sides)
//   and the finale ramp, and restoring all three;
// - the mirror's repaint budget, which is the only assertion that the quantizer
//   is on the path rather than merely present in the source;
// - the awareness tell being fed the real meter, and §7.4's banish stopping it.
//
// MUTATION-TESTED, because a check that cannot fail is worse than no check
// -----------------------------------------------------------------------
// Seven mutations were tried and the suite caught six: never re-locking into a
// pause, not dropping held keys, a head bob that ignores the switch, an
// unquantized awareness, a shake banked while suppressed, and a finale ramp that
// ignores reduced motion. Two survived and both are honest:
//   - dropping the `|| this.paused` guard in `_onLockChange` is *equivalent*,
//     because `setPaused(true)` on an already-paused world is a no-op. The guard
//     stays because it documents the intent, and the pure gate pins its source.
//   - draining a pending swing with `consumeSwing()` instead of
//     `releaseAllKeys()` is unobservable *here*, because the world never sets
//     `onSwing` — but it is wrong, and it is wrong in a way that would banish
//     something the moment the real callback existed. Slice 12 removed the call
//     rather than the test, and `verify.mjs` now asserts the absence directly.

// --- slice 12: the HUD mirror, pause, and motion sensitivity ----------------

check('the sigil state tracks portal state through a reset', () => {
  game.restart()
  run(game, 1.6)
  const shot = () => game.store.get().portals
  assert.deepEqual(Object.values(shot()), [false, false, false], 'a fresh run is not all-lit')
  // shut one for real: a held key, a real hold, through the world's own verb
  const entry = game.streetView.portals[0]
  const spot = game.streetView.worldOf(entry.position)
  game.player.teleport(spot.x, spot.z, 0)
  game.player.pressKey('KeyE')
  run(game, 1.4)
  game.player.releaseKey('KeyE')
  assert.equal(shot()[entry.id], true, 'the portal did not shut')
  assert.equal(Object.values(shot()).filter(Boolean).length, 1)
  // §9.1: a capture keeps shut portals, so the sigil has to still be dark
  game._capture()
  run(game, 1.4)
  assert.equal(shot()[entry.id], true, 'a capture un-shut a portal, or the sigil re-lit itself')
  assert.equal(Object.values(shot()).filter(Boolean).length, 1)
  // and the *wipe* is the one place they come back, which is §10.4
  game.restart()
  run(game, 0.3)
  assert.deepEqual(Object.values(shot()), [false, false, false], 'BEGIN AGAIN did not restore the sigils')
})

check('the hold ring reaches exactly 1.0 and its tick passes the noise threshold', () => {
  game.restart()
  run(game, 1.6)
  const entry = game.streetView.portals[0]
  const spot = game.streetView.worldOf(entry.position)
  game.player.teleport(spot.x, spot.z, 0)
  game.update(DT) // one frame, so the verb has run and the prompt is on screen
  assert.equal(game.store.get().hold, 0)
  assert.equal(game.store.get().prompt, 'portal', 'standing at a portal shows no prompt')
  const seen = []
  game.player.pressKey('KeyE')
  for (let i = 0; i < Math.round(1.25 / DT); i += 1) {
    game.update(DT)
    seen.push(game.store.get().hold)
  }
  game.player.releaseKey('KeyE')
  // the ring is the one new geometry, and it has to close *exactly*
  assert.equal(Math.max(...seen), 1, `the ring peaked at ${Math.max(...seen)}`)
  // the tick and the sound event cross on the same frame, by construction
  const firstLoud = seen.findIndex((value) => value >= 0.5)
  assert.ok(firstLoud > 0, 'the ring never reached its midpoint tick')
  const progressAtTick = game.state.progress[entry.id]
  assert.ok(progressAtTick >= 0.5, 'the ring passed the tick before the rule did')
  // and §5.2's rule is what closed it, not the ring
  assert.equal(game.state.portals[entry.id], true)
  // a fresh hold starts from nothing: 0 -> 1 -> 0
  game.restart()
  run(game, 1.6)
  assert.equal(game.store.get().hold, 0, 'the ring did not reset')
})

check('the ring bleeds off when the hold is released, so aborting is visibly free', () => {
  game.restart()
  run(game, 1.6)
  const entry = game.streetView.portals[0]
  const spot = game.streetView.worldOf(entry.position)
  game.player.teleport(spot.x, spot.z, 0)
  game.player.pressKey('KeyE')
  run(game, 0.5)
  const held = game.store.get().hold
  assert.ok(held > 0.2, 'the hold did not progress')
  game.player.releaseKey('KeyE')
  run(game, 0.8)
  assert.ok(game.store.get().hold < held, 'the ring froze instead of bleeding off')
  assert.equal(game.state.portals[entry.id], false, 'a released hold still shut the portal')
})

check('pause freezes the creature as well as the player', () => {
  game.restart()
  run(game, 1.6)
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.5 })
  placeCreature(game, 4)
  game.player.pressKey('KeyW')
  // §5.2's hold is down when the player pauses: the commitment must not survive
  // the menu, or it would resume by itself the moment they came back
  game.player.pressKey('KeyE')
  run(game, 0.5)
  // and a pending swing is dropped with it: a pause caught mid-click must not
  // resume as a banish the player never aimed. Raised *after* the run above,
  // because a real frame would have consumed it.
  game.player.pressButton(0)
  assert.equal(game.player.swingRequested, true, 'the harness is not actually mid-swing')
  const before = {
    x: game.player.pos.x,
    z: game.player.pos.z,
    animTime: game.animTime,
    creature: { ...game.creature },
    creaturePosition: { ...game.creaturePosition },
    awareness: game.creatureAwareness,
    shake: game.shake,
  }
  assert.equal(game.setPaused(true), true, 'the pause did not take')
  assert.equal(game.store.get().paused, true)
  assert.equal(game.player.interactHeld(), false, 'a held key survived the pause')
  assert.equal(game.player.keys.size, 0, 'the pause did not drop every held key')
  assert.equal(game.player.consumeSwing(), false, 'a pending swing survived the pause')
  assert.equal(game.state.banishCount, 0, 'the pause banished something')
  assert.equal(game.store.get().hold, 0, 'the ring kept a hold through the pause')
  // every clock in the world stops, the creature included
  game.player.pressKey('KeyW')
  run(game, 1.5)
  assert.equal(game.player.pos.x, before.x, 'the player walked while paused')
  assert.equal(game.player.pos.z, before.z, 'the player walked while paused')
  assert.equal(game.animTime, before.animTime, 'the world clock ran while paused')
  assert.deepEqual(game.creature, before.creature, 'the creature state machine ran while paused')
  assert.deepEqual(game.creaturePosition, before.creaturePosition, 'the creature walked while paused')
  assert.equal(game.creatureAwareness, before.awareness, "the creature's awareness decayed while paused")
  assert.equal(game.shake, before.shake, 'the shake decayed while paused')
  // and a paused frame is routed as silence rather than frozen audio
  audio.calls.length = 0
  run(game, 0.5)
  assert.ok(audio.calls.includes('update'), 'the router was not called on a paused frame')
  assert.equal(audio.calls.includes('breath'), false, 'a paused frame kept breathing')
  assert.equal(game.setPaused(false), true, 'the resume did not take')
  assert.equal(game.store.get().paused, false)
  run(game, 0.3)
  assert.ok(game.animTime > before.animTime, 'the world did not restart')
})

check('losing pointer lock pauses, and the pause cannot be undone by the lock', () => {
  game.restart()
  run(game, 1.6)
  assert.equal(game.paused, false)
  game._onLockChange()
  assert.equal(game.paused, true, 'alt-tabbing away did not pause the game')
  // the lock-change that the pause itself causes must not toggle it back off,
  // and a lock we failed to re-acquire must never resume on its own
  game._onLockChange()
  assert.equal(game.paused, true, 'a second lock event un-paused the game')
  assert.equal(game.setPaused(false), true)
  run(game, 0.05)
  game._onLockChange()
  assert.equal(game.paused, false, 'the grace window did not cover the re-lock')
  // and a real loss after the grace window does pause
  run(game, 0.8)
  game._onLockChange()
  assert.equal(game.paused, true, 'a genuine lock loss was swallowed by the grace window')
  game.setPaused(false)
})

check('reduced motion suppresses head bob, camera shake and finale effects', () => {
  game.restart()
  run(game, 1.6)
  // the OS preference seeds the game, and the player's toggle overrides it
  assert.equal(game.reducedMotion, false, 'motion is off by default')
  game.setReducedMotion(true)
  assert.equal(game.reducedMotion, true)
  assert.equal(game._motion.headBob, false)
  assert.equal(game._motion.cameraShake, false)
  assert.equal(game._motion.finaleEffects, false)
  assert.equal(game.store.get().motionPreference, true)
  // the head bob: the camera's Y is pinned while walking
  game.player.pressKey('KeyW')
  run(game, 1.0)
  const heights = new Set()
  for (let i = 0; i < 12; i += 1) {
    game.update(DT)
    heights.add(game.camera.position.y.toFixed(6))
  }
  assert.equal(heights.size, 1, `the camera is still bobbing under reduced motion (${heights.size} heights)`)
  assert.equal(game.player.bobScale, 0)
  game.player.releaseKey('KeyW')
  // the shake: a capture must not accumulate one it will never apply
  game.addShake(0.9)
  assert.equal(game.shake, 0, 'a shake was banked under reduced motion')
  game._applyShake(DT)
  assert.equal(game.shake, 0)
  // the finale: §14.3's screen effects are off, and the level stays at zero
  game.state = { ...game.state, finale: true }
  run(game, 12)
  assert.equal(game.finaleEffect.level, 0, 'the finale ramped under reduced motion')
  // and turning it back off gives all three back
  game.setReducedMotion(false)
  assert.equal(game.player.bobScale, 1)
  game.player.pressKey('KeyW')
  run(game, 1.0)
  const bobHeights = new Set()
  for (let i = 0; i < 24; i += 1) {
    game.update(DT)
    bobHeights.add(game.camera.position.y.toFixed(6))
  }
  assert.ok(bobHeights.size > 1, 'the head bob did not come back')
  game.player.releaseKey('KeyW')
  run(game, 12)
  assert.ok(game.finaleEffect.level > 0, 'the finale never ramped with motion on')
  game.addShake(0.9)
  assert.ok(game.shake > 0, 'the shake never came back')
})

check('the HUD mirror does not re-render React every frame', () => {
  // `createStore` skips notifying when every patched key is `===`, so this is
  // the check that the quantizer is actually on the path: a still player in a
  // still street must cost React nothing, and a held ring must cost it about one
  // repaint per grid step rather than one per frame.
  game.restart()
  run(game, 1.6)
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  run(game, 1.0)
  const idle = notifications
  assert.ok(idle <= 2, `${idle} repaints on a still frame in a still street`)
  notifications = 0
  const entry = game.streetView.portals[0]
  const spot = game.streetView.worldOf(entry.position)
  game.player.teleport(spot.x, spot.z, 0)
  game.player.pressKey('KeyE')
  run(game, 1.2)
  game.player.releaseKey('KeyE')
  const frames = Math.round(1.2 / DT)
  const holding = notifications
  assert.ok(holding > 0, 'a hold repainted nothing at all')
  assert.ok(holding < frames / 2, `${holding} repaints in ${frames} frames: the ring is not quantized`)
  unsubscribe()
})

check('the awareness tell is fed the meter, and stops when the creature is gone', () => {
  game.restart()
  run(game, 1.6)
  // Act I's creature is a TELEGRAPH: §6.1 says it is a sighting, so it is
  // legitimately "present" — and §8.1's immunity is what pins the meter to zero,
  // so the tell has nothing to show even though a figure is on the street
  assert.equal(game.creature.state, 'telegraph')
  assert.equal(game.store.get().creaturePresent, true, 'a telegraph sighting is not a presence')
  assert.equal(game.store.get().awareness, 0, '§8.1: Act I deafness did not hold')
  // a stalking creature with a filling meter has to reach the store
  game.creature = beast.createCreature({ state: 'stalk' })
  placeCreature(game, 5)
  game.player.pressKey('KeyW')
  run(game, 1.2)
  const meter = game.store.get().awareness
  assert.ok(meter > 0, `§6.2's meter never reached the HUD (${meter})`)
  assert.equal(meter, Math.round(meter * hud.STEPS.awareness) / hud.STEPS.awareness, 'the meter is unquantized')
  assert.equal(game.store.get().creaturePresent, true)
  // ...and the *same* meter reached the audio frame. The HUD reads the quantized
  // copy and the audio reads the raw one, so they are two doors off one number and
  // a world that fed only the first would look correct to every check above.
  // §13 prices the proximity breath off this one (`rate` and `sharp`), so a break
  // here is a creature that is metres away and breathing calmly.
  assert.ok(game.creatureAwareness > 0, 'the world did not keep the meter at all')
  assert.equal(
    audio.lastFrame.creatureAwareness,
    game.creatureAwareness,
    'the audio frame and the world disagree about the meter',
  )
  assert.ok(
    audio.lastFrame.creatureAwareness > meter,
    'and the audio frame has the unquantized one, which is what §13 prices',
  )
  game.player.releaseKey('KeyW')
  // §7.4: a banished creature is off the field, so the vignette it drives stops
  game.state = { ...game.state, banishCount: 1 }
  game.creature = beast.createCreature({ state: 'stagger', banishCount: 1 })
  run(game, 0.2)
  assert.equal(game.store.get().creaturePresent, false, 'a banished creature is still being read')
  // and a capture wipes it
  game._capture()
  run(game, 0.2)
  assert.equal(game.store.get().awareness, 0, 'a capture kept the awareness vignette')
})

check('the pause card\'s two calls are the only doors React has into the world', () => {
  // §14.3 promises a toggle, and a toggle has to be operable; these are the two
  // methods `PauseOverlay` can reach, and the world is what they change
  assert.equal(typeof game.setPaused, 'function')
  assert.equal(typeof game.togglePause, 'function')
  assert.equal(typeof game.setReducedMotion, 'function')
  game.restart()
  run(game, 1.6)
  game.togglePause()
  assert.equal(game.paused, true, 'the toggle did not pause')
  game.togglePause()
  assert.equal(game.paused, false, 'the toggle did not resume')
  // and `tryInteract` is frozen by the same flag, so a one-shot caller cannot
  // drive a verb through the pause
  game.setPaused(true)
  assert.equal(game.tryInteract(DT), false, 'tryInteract ran through a pause')
  game.setPaused(false)
})

// ---------------------------------------------------------------------------
// slice 13 — the finale and the win
//
// Five checks, and the first one is the reason this block exists at all: it
// drives the three portals through the *real* hold — walk the body to the
// anchor, press E, let `applyPortalHold` fill — rather than setting
// `state.finale` and reading it back. Every earlier block in this file sets
// state and asserts a consequence, which cannot tell "the trigger works" from
// "the flag was already true". This one can: if the third portal stopped being
// the trigger, the second shutdown would light the headlights and the first
// would enrage the creature, and both are watched here against a body that has
// never been told anything.
//
// The other four are the plan's own list: ENRAGED, the headlights, the win, and
// BEGIN AGAIN. Two of their rules (§10.2's banish window and §10.3's fog) are
// pure and are asserted in `verify.mjs`; what a world check adds is that the
// *world* reads them — that the re-emergence clock it runs is the flat one, and
// that the lamps it lights are the ones that ignore fog.
//
// All five landed as written. The scratch copy this was transcribed from is not
// committed; the 2D context it needed is the stub at the top of this file.

check('the third portal and only the third opens the finale', () => {
  game.restart()
  run(game, 1.6)
  game.state = { ...game.state, hammerHeld: true }
  // the creature is awake and hunting, so the enrage is a real consequence
  // rather than an Act I apparition that cannot promote
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.5 })
  placeCreature(game, 30)

  const shut = []
  for (const entry of game.streetView.portals) {
    const at = game.streetView.worldOf(entry.position)
    game.player.teleport(at.x, at.z, 0)
    run(game, DT)
    let frames = 0
    while (!game.state.portals[entry.id] && frames < 600) {
      game.tryInteract(DT)
      frames += 1
    }
    assert.equal(game.state.portals[entry.id], true, `${entry.id} never shut through the real hold`)
    shut.push(entry.id)
    // §10.1: the flag is the count, and only the count. The headlights and the
    // creature are the two things that read it, so they are what is watched.
    assert.equal(game.state.finale, shut.length === 3, `the finale opened after ${shut.length} portals`)
    assert.equal(game.streetView.exitCar.lit, shut.length === 3, 'the headlights disagree with the finale')
    if (shut.length < 3) {
      assert.notEqual(game.creature.state, 'enraged', `the creature enraged after ${shut.length} portals`)
    }
    // §5.4: the rule flipping is not the promise, the *street* going dark is. The
    // rule state is a boolean in a store and a store survives a refactor; the
    // ring's material and the lamp behind it are what the player walks past for
    // the rest of the run. Added in slice 14 because mutation testing found this
    // line unobserved: making `_onPortalShut` ignore every id but `C` left the
    // whole suite green, because nothing between the verb and the geometry was
    // being checked.
    const view = game.streetView.portals.find((candidate) => candidate.id === entry.id)
    assert.equal(view.shut, true, `${entry.id} is not dark in the world`)
    assert.equal(view.light.intensity, 0, `${entry.id} is still throwing light`)
    assert.equal(view.light.visible, false, `${entry.id}'s lamp is still on`)
    assert.equal(
      view.rim.material,
      game.streetView._materials.portalDead,
      `${entry.id} is still wearing the live material on its rim`,
    )
    // ...and the disc, which is the bigger half of the gate after iteration 2,
    // pass 3 and the half a screenshot of a shut portal is mostly made of. This
    // line is the mutation test for the rebuild: deleting the disc assignment in
    // `setPortalShut` left the whole suite green before, because nothing between
    // the verb and the hole was being looked at.
    assert.equal(
      view.disc.material,
      game.streetView._materials.portalCoreDead,
      `${entry.id}'s hole is still lit from behind`,
    )
    for (const layer of view.swirl) {
      assert.equal(layer.visible, false, `${entry.id}'s swirl is still turning in a dead portal`)
    }
    for (const other of game.streetView.portals) {
      if (shut.includes(other.id)) continue
      assert.equal(other.shut, false, `${other.id} went dark without being shut`)
    }
  }
  assert.deepEqual(shut, [...hood.PORTAL_IDS])
  assert.equal(game.state.finale, true, 'the third portal did not open the finale')
  assert.equal(game.state.dusk, 1, '§3.7: the fog closed to dusk 1 with it')
  assert.equal(game.state.hammerHeld, true, 'and nothing about the finale touched the hammer')
  // the last two consequences, on the frame after the third — still without a
  // single line of state written by this check beyond the hold itself
  game.update(DT)
  assert.equal(game.creature.tier, 3, '§11.1: the tier is the portals shut, and the world hands it over every frame')
  assert.equal(game.creature.state, 'enraged', '§10.2: the third portal enrages the creature')
  assert.equal(game.creature.awareness, beast.AWARENESS_CHASE, 'with the meter already full')
  // and it is spending 5.2 m/s on the ground, which is the only thing that makes
  // §10.2's "sprint remains the escape" a fact about the world and not a number
  // in a table. Until slice 13 the walk was gated on STALK, so this creature
  // stood still with perfect knowledge and the climax was a walk to the car.
  // 150 m is two whole blocks: at a shorter range the creature and the player can
  // share one intersection node, and `nextHop` has nothing to hand back.
  placeCreature(game, 150)
  const from = { ...game.creaturePosition }
  run(game, 0.5)
  const closed = Math.hypot(
    beast.wrapDelta(from.x, game.creaturePosition.x),
    beast.wrapDelta(from.z, game.creaturePosition.z),
  )
  assert.ok(closed > beast.SPEED_CEILING * 0.5 * 0.6, `it moved ${closed.toFixed(2)} m in half a second; 5.2 m/s is 2.6`)
  assert.ok(closed <= beast.SPEED_CEILING * 0.5 + 1e-6, 'and it never exceeded the ceiling')
  assert.ok(closed < beast.PLAYER_SPRINT_SPEED * 0.5, 'and the sprint still beats it')
})

check('the finale enrages the creature, and the hammer still answers', () => {
  game.restart()
  run(game, 1.6)
  game.state = { ...game.state, finale: true, hammerHeld: true }
  // 1.6 m: inside the hammer's 2.6 m banish range and outside the 1.1 m contact
  // radius, so the swing below is a banish and not a capture. Standing at 1 m
  // would be a capture on the same frame the enrage fires, which is correct
  // behaviour and a useless place to assert it from.
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.5, finale: true })
  placeCreature(game, 1.6)
  game.update(DT)
  assert.equal(game.creature.state, 'enraged', '§10.2')
  // the tier follows the *portal count*, not the flag: this check raises the flag
  // by hand without shutting anything, so the world's own line says tier 0 — and
  // the check above is where the two are shown to be the same thing for real
  assert.equal(game.creature.tier, 0, 'the world hands the creature the portals-shut count, not the finale flag')
  assert.equal(game.creature.awareness, beast.AWARENESS_CHASE, 'permanent position knowledge')
  // a connected swing banishes, and the window the world then runs is the flat
  // one rather than a rung of §7.4's ladder — this is the only place the world's
  // own re-emergence clock is visible
  game.player.pressButton(0)
  game.update(DT)
  game.player.releaseButton(0)
  assert.equal(game.state.banishCount, 1, 'the ladder advanced, as a connected swing must')
  const window = beast.banishWindow({ state: 'stagger', banishCount: game.state.banishCount, finale: true })
  assert.equal(window, beast.ENRAGED_REEMERGENCE_SECONDS, 'the finale ignored the ladder')
  assert.equal(window, 1.5, '§10.2 / §16.3: the flat short delay, at its documented candidate')
  // §7.4's recoil and §10.2's window are two different clocks, and the world's
  // is the second one: the creature is still reeling at the end of the window
  run(game, window + 0.1)
  assert.equal(game.creature.state, 'stagger', 'the window swallowed the §7.4 recoil')
  run(game, beast.STAGGER_SECONDS)
  assert.equal(game.creature.state, 'enraged', 'and it came back angry, on the flat delay plus the recoil')
  assert.equal(game.creature.reemergenceCount, 1, '§11.2: the pressure axis counted the re-emergence')
  // §10.2's speed is spent on locomotion: an enraged creature closes on the
  // player, at the ramp speed for the tier the world was given rather than at
  // zero. The measurement is a straight-line closure, so a path that turns a
  // corner can only report *less* than the distance walked — which is why the
  // ceiling is an upper bound here and the floor is deliberately loose. 150 m is
  // two whole blocks, for the same `nextHop` reason as the check above.
  placeCreature(game, 150)
  const from = { ...game.creaturePosition }
  run(game, 0.5)
  const closed = Math.hypot(
    beast.wrapDelta(from.x, game.creaturePosition.x),
    beast.wrapDelta(from.z, game.creaturePosition.z),
  )
  const expected = beast.creatureSpeed(game.creature.tier, game.creature.reemergenceCount) * 0.5
  assert.ok(closed > expected * 0.6, `the enraged creature moved ${closed.toFixed(2)} m in half a second; ${expected.toFixed(2)} m is its ramp speed`)
  assert.ok(closed <= beast.SPEED_CEILING * 0.5 + 1e-6, 'and it never exceeded the §8.6 ceiling')
  assert.equal(game.creature.state, 'enraged', 'and it was still hunting after all of that')
})

check('the exit car lights up, and the lamps are the ones that read through fog', () => {
  game.restart()
  run(game, 1.6)
  const car = game.streetView.exitCar
  assert.equal(car.lit, false, '§10.3: the car is dark in Act I')
  for (const lamp of car.lamps) assert.equal(lamp.visible, false, 'and it is not a pair of glowing boxes either')
  assert.equal(car.beam.intensity, 0)
  assert.equal(game.scene.fog.density, rules.fogDensityForDusk(0), 'Act I is the open fog')
  // §10.3: the finale lights it, and the fog is at its tightest on the same
  // frame, which is the whole problem the headlights solve
  game.state = { ...game.state, finale: true, dusk: 1 }
  game._onPortalShut('C')
  game._applyDusk(1)
  assert.equal(car.lit, true, 'the finale did not light the car')
  for (const lamp of car.lamps) assert.equal(lamp.visible, true, 'a lamp stayed dark')
  assert.ok(car.beam.intensity > 0, 'and the beam never came on')
  // the beam outlasts the fog, and the lamps ignore it: at dusk 1 the world is
  // half opaque at about 32 m, so a lit surface would be a glow twenty metres out
  const half = rules.fogVisibility(game.scene.fog.density)
  assert.ok(car.beam.distance > half, `the beam reaches ${car.beam.distance} m and the fog is half opaque at ${half.toFixed(1)}`)
  for (const lamp of car.lamps) {
    assert.equal(lamp.material.fog, false, 'the headlights are fogged out, so the beacon cannot be seen coming')
  }
  // and the body is parked *beside* the win anchor, so the player can stand in
  // their own win trigger (§10.3): 2.6 m of kerbside, against a 1.15 m radius
  // and a 0.36 m player body. The rule is checked on the *canonical* anchor,
  // because the drawn car is in the folded copy and the win is not.
  const anchor = game.streetView.worldOf(game.state.exitAnchor.position)
  const offset = Math.hypot(car.root.position.x - anchor.x, car.root.position.z - anchor.z)
  assert.ok(offset > rules.EXIT_WIN_RADIUS, 'the car body is centred on the win anchor and the player cannot reach it')
  assert.equal(
    rules.checkExitWin({ ...game.state, finale: true }, game.state.exitAnchor.position),
    true,
    'and standing on the anchor wins',
  )
})

check('walking into the exit wins, rings once, and freezes the world', () => {
  game.restart()
  run(game, 1.6)
  const anchor = game.streetView.worldOf(game.state.exitAnchor.position)
  // §10.4: the geometry alone wins nothing, and the car has been there all run
  game.player.teleport(anchor.x, anchor.z, 0)
  audio.calls.length = 0
  game.update(DT)
  assert.notEqual(store.get().phase, PHASE.WON, 'won before the finale')
  game.state = { ...game.state, finale: true }
  audio.calls.length = 0
  game.update(DT)
  assert.equal(store.get().phase, PHASE.WON, '§10.4: walking into the exit did not win')
  assert.equal(game.player.enabled, false, 'the player is still walking behind the card')
  assert.equal(audio.calls.filter((name) => name === 'winChord').length, 1, 'the win chord did not ring exactly once')
  // the freeze: nothing in the world moves, and the one thing that does is the fade
  const at = { x: game.player.pos.x, z: game.player.pos.z, fade: game.fade }
  const frozen = { ...game.creaturePosition }
  for (let i = 0; i < 60; i += 1) game.update(DT)
  assert.equal(game.player.pos.x, at.x, 'the player kept walking after the win')
  assert.equal(game.player.pos.z, at.z)
  assert.deepEqual(game.creaturePosition, frozen, 'the creature kept hunting after the win')
  assert.ok(game.fade > at.fade, 'but the fade stopped, so the card has nothing behind it')
  // and the chord is not rung again by standing in the car for a second
  audio.calls.length = 0
  for (let i = 0; i < 60; i += 1) game.update(DT)
  assert.equal(audio.calls.includes('winChord'), false, 'the chord rang again while the player stood in the exit')
})

check('BEGIN AGAIN is a full wipe: loop 1, no portals, no hammer, no counters', () => {
  // §10.4 against §9.1: this is the one button that takes the achieved column
  // too, and the only difference between the two tables is that.
  game.restart()
  run(game, 1.6)
  game.state = { ...game.state, finale: true, dusk: 1, hammerHeld: true, banishCount: 3, loop: 6 }
  for (const portal of game.streetView.portals) game.streetView.setPortalShut(portal.id, true)
  game.streetView.setHammerTaken(true)
  game.streetView.setHeadlights(true)
  game.creature = beast.createCreature({ state: 'enraged', awareness: 1, finale: true, reemergenceCount: 3 })
  placeCreature(game, 4)
  game.portalNoiseElapsed = { A: 9, B: 9, C: 9 }
  game.hammerFlash = 1
  game.finaleEffect = { level: 0.83, hold: 1.5 }

  game.restart()
  assert.equal(game.state.loop, 1, '§9.2: the counter counts captures, and a new run is zero of them')
  assert.equal(game.state.finale, false, 'the finale survived BEGIN AGAIN')
  assert.equal(game.state.dusk, 0, 'the fog did not reopen')
  assert.equal(game.state.hammerHeld, false, 'the hammer survived BEGIN AGAIN')
  assert.equal(game.state.banishCount, 0, 'the banish ladder survived BEGIN AGAIN')
  assert.equal(game.state.breath, 1, 'and a new run starts winded')
  assert.equal(game.state.exhausted, false)
  for (const id of hood.PORTAL_IDS) {
    assert.equal(game.state.portals[id], false, `${id} is still shut`)
    assert.equal(game.state.progress[id], 0, `${id} kept a half-finished hold`)
    assert.equal(game.portalNoiseElapsed[id], 0, `${id} kept its §5.2 sound window`)
  }
  assert.equal(game.state.creature.state, 'telegraph', 'the state opened in Act II')
  assert.equal(game.creature.state, 'telegraph')
  assert.equal(game.creature.reemergenceCount, 0, 'the pressure axis survived BEGIN AGAIN')
  assert.equal(game.streetView.exitCar.lit, false, 'the headlights survived BEGIN AGAIN')
  assert.equal(game.streetView.hammer.taken, false, 'the hammer is still out of its clearing')
  for (const portal of game.streetView.portals) {
    assert.equal(portal.shut, false, `${portal.id} is still dark in the world`)
  }
  assert.equal(game.hammerFlash, 0, '§14.3: the sigil flash survived')
  assert.equal(game.finaleEffect.level, 0, '§14.3: the finale ramp survived')
  assert.equal(game.player.enabled, false, 'the player can walk through the black of a wipe')
  // the wipe is a reset, so the player is back at spawn and the run plays on
  assert.ok(Math.hypot(game.player.pos.x - hood.SPAWN.position.x, game.player.pos.z - hood.SPAWN.position.z) < 0.01)
  run(game, 2.0)
  assert.equal(store.get().phase, PHASE.PLAYING, 'and play resumes')
  assert.equal(game.player.enabled, true)
  assert.equal(store.get().loop, 1, 'the HUD is showing loop 1')
})
// ---------------------------------------------------------------------------
// teardown — last, and that is the whole reason
//
// v1 ran its `dispose()` check one block up from the end and the parked slice-10
// block carried a second one of its own, and both were *before* the blocks that
// needed a live world. Nothing failed: `update` has no `disposed` guard, the
// street view is emptied rather than nulled, and every check after them kept
// passing against a half-freed world. A teardown in the middle of a suite is the
// one failure mode that cannot announce itself, so both live here now.
// ---------------------------------------------------------------------------

check('the stub is a surface, and it is not a smaller world than the code', () => {
  // The reason the harness spent five slices reporting `1/12` is that v1's stub
  // had five members and v1's six procedural textures drew through
  // `beginPath`/`ellipse`/`fill`. Nothing ran it, so nothing said so. The repair is
  // the full drawing surface, and this check is what stops the next person from
  // quietly deleting half of it: it walks every member of the surface a texture
  // can reach for and asserts none of them is missing.
  const canvas = makeCanvas()
  const ctx = canvas.getContext('2d')
  const surface = [
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
    'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill', 'stroke', 'clip',
    'fillRect', 'strokeRect', 'clearRect', 'drawImage', 'save', 'restore', 'scale',
    'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'fillText',
    'strokeText', 'measureText', 'createImageData', 'getImageData', 'putImageData',
    'createLinearGradient', 'createRadialGradient', 'createConicGradient',
    'createPattern', 'setLineDash', 'getLineDash', 'isPointInPath',
  ]
  const missing = surface.filter((name) => typeof ctx[name] !== 'function')
  assert.deepEqual(missing, [], `the 2D stub is missing ${missing.join(', ')}`)
  // ...and it is a *surface*, not an implementation: calling all of it draws
  // nothing, throws nothing, and leaves the context usable.
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(10, 10)
  ctx.quadraticCurveTo(1, 2, 3, 4)
  ctx.bezierCurveTo(1, 2, 3, 4, 5, 6)
  ctx.arc(0, 0, 4, 0, Math.PI)
  ctx.ellipse(0, 0, 4, 2, 0, 0, Math.PI)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.clip()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.resetTransform()
  ctx.fillStyle = ctx.createLinearGradient(0, 0, 1, 1)
  ctx.fillRect(0, 0, 4, 4)
  ctx.restore()
  // the one member that is *not* a stub, because `streetView` writes every texel
  // through it and a texture that throws on `data[i] = value` is a real bug
  const image = ctx.createImageData(8, 8)
  assert.equal(image.data.length, 8 * 8 * 4, 'createImageData allocates a real buffer')
  ctx.putImageData(image, 0, 0)
  // and `getContext` memoizes, so the context a texture was drawn on is the
  // context a later `three` call gets back
  assert.equal(canvas.getContext('2d'), ctx, 'getContext must return the same context')
})

// ===========================================================================
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
const COMPETENT = Object.freeze({ sprint: true, swing: true, hide: true, fight: true, hunt: false, skipHammer: false, label: 'competent' })
const CARELESS = Object.freeze({ sprint: false, swing: false, hide: false, fight: false, hunt: false, skipHammer: false, label: 'careless' })
const RECKLESS = Object.freeze({ sprint: true, swing: false, hide: false, fight: false, hunt: true, skipHammer: false, label: 'reckless' })

/** §6.2's hiding, as a policy: the three numbers a competent player reads off the HUD. */
const HIDE_RANGE = 34
const HIDE_METER = beast.AWARENESS_CHASE_RELEASE + 0.05
const HIDE_BREATH = 0.45
const HIDE_MAX_SECONDS = 3
/**
 * Inside this the hammer is the answer, and standing still is how you swing it.
 *
 * SLICE 15: 26 -> 45 -> 22, and the number is §11.1's own detection table rather
 * than a feel. Two things have to be true at once and only one value is both. It has
 * to be *inside* every range the creature can see the player at — 14, 17 and 20 m
 * for the three pre-finale tiers — because a swing needs contact and a creature that
 * has not noticed you does not come. And it has to be as *close* to that edge as it
 * can be, because standing still to wait for a thing is on-field time: at 45 m the
 * competent player spent a hundred and fifty seconds of the first third of a run
 * standing in the road, which is a share of 0.92 before the ladder has bought a
 * single second of quiet, and it left the late-run trend with eight thousandths of
 * margin to prove itself on. 22 m is the edge of the table — the last metre before a
 * tier-2 creature can see you — so the wait is as short as the rules allow and the
 * hammer comes out the moment it has to.
 */
const FIGHT_RANGE = 22

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
  const store = createStartStore()
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
  const image = hood.nearestImage(canonical, world.player.pos)
  const origin = world.streetView.origin
  return { x: image.x + origin.x, z: image.z + origin.z }
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
  //
  // ...unless it has the hammer, in which case standing still is how you *use* it:
  // §7.4's banish needs the creature inside BANISH_RANGE, so a player who hides from
  // thirty metres never gets one, and §7.4's ladder — the only thing in the game that
  // makes it easier — never moves. A player with a hammer holds its ground when the
  // thing is close enough to hit, turns no lights on, and swings. That is the Act II
  // loop the design describes, and it is the difference between a competent player
  // who survives and one who *improves*.
  // §7.4's Act II loop, and the reason the hammer is a tool rather than a souvenir:
  // a player holding it does not run from a chase, it stands its ground and lets the
  // thing come inside `BANISH_RANGE`. A chasing creature walks at the player at the
  // tier's speed, so the fight is something the creature *delivers*; and silence,
  // which lets the meter decay out of the chase band, is the answer for a player who
  // has no way to answer it. The hammer REPLACES the hiding rather than competing
  // with it, and the gate is the hammer and not the distance: allowed to hide from
  // 34 m while only willing to fight inside 26 m, the competent player hid the whole
  // way in — the meter decayed, the chase released, the creature walked to a position
  // the player had already left, and it closed to 26 m exactly never. Zero connected
  // swings across eight full runs, so §7.4's ladder, the only thing in the game that
  // makes it easier, never moved a rung and §11.3's first trend had no mechanism
  // behind it at all.
  //
  // Standing still to fight is also the safe half of the bargain, and it is safe
  // because of the state list rather than in spite of it: `CAPTURE_STATES` is CHASE
  // and ENRAGED, so a creature that has lost the plot is standing in front of you
  // unable to touch you, and a connected swing is a full removal. That is §6.1's
  // promise and §7.4's, and it is the only reason the hammer is worth carrying.
  //
  // AND A HUNT IS THE DELIVERY MECHANISM, which is the second half of the same claim
  // and the one the numbers forced. A creature in CHASE walks *at* the player at the
  // tier's speed; a creature in STALK walks at where it last heard you, which is a
  // point you have already left. So a player who runs from every chase never lets it
  // arrive, and the whole of Act II measured that way is 88% on-field and 98 m away:
  // presence without threat, the hammer never swung, §7.4's ladder frozen on its
  // first rung and §11.3's first trend with nothing behind it. With the hammer in
  // hand the player holds its ground instead, the chase delivers it, and the swing
  // pays for the next minute of quiet.
  const canFight = plan.fight && world.state.hammerHeld
  const fighting = canFight && creatureGap < FIGHT_RANGE
  let hiding = false
  if (plan.hide && !canFight && hunted && creatureGap < HIDE_RANGE && player.breath > HIDE_BREATH) {
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
  if (hiding || fighting) control.key = null
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
  if (hiding || fighting) dropKey(player, 'KeyW')
  else holdKey(player, 'KeyW')

  // §5.2's hold, in reach only: a hold on nothing is a hold that bleeds off
  const reach = goal.kind === 'portal' ? 2.0 : goal.kind === 'hammer' ? 1.1 : 0.9
  if (gap <= reach) holdKey(player, 'KeyE')
  else dropKey(player, 'KeyE')

  // the sprint: to open a gap, in bursts, and never while hiding or fighting
  //
  // AND ONLY IN THE FINALE, which is the third and last piece of the Act II loop and
  // the one the ladder depends on. §6.2's table is a sprint at 22 m, the loudest
  // thing in the game, and §11.1 never grants the creature more than 5.2 — so
  // sprinting from a chase buys 0.8 m/s of margin and a neighbourhood full of
  // witnesses, forever, and the creature that was closing goes back to being a
  // rumour. Measured that way, eight competent runs produced 0.0 banishes per
  // encounter, 88% on-field and 98.8 m: the whole of Act II was presence without
  // threat. A player carrying a bell-hammer does not do that. It keeps shutting
  // portals, lets the thing come, and answers it — and §7.4's ladder, the only thing
  // in the game that makes it easier, is what pays for the quiet it works in.
  //
  // §10.2 is the exception that proves the rule: a finale banish is a flat
  // `ENRAGED_REEMERGENCE_SECONDS` and the ladder is ignored, so at the climax the
  // only thing that beats 5.2 m/s is 6.0 and the car is the objective. Sprint there,
  // swing only when it is already on top of you.
  const panicky = ON_FIELD.includes(creature.state) && creatureGap < 15
  const runsFrom = plan.sprint && (world.state.finale === true || !canFight)
  if (runsFrom && !hiding && !fighting && player.breath > 0.15 && (hunted || panicky)) holdKey(player, 'ShiftLeft')
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
    closest: Infinity,
    closestState: null,
    closestFinale: false,
    inReach: 0,
    captureEvents: [],
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

/**
 * watchCaptures — count the run's captures at the moment the world decides them.
 *
 * The tally also infers a capture from `state.loop`, which is a delayed,
 * §9.3-flavoured signal: a capture hides behind the black and the loop counter is
 * what eventually says so. Asking the world directly — by wrapping the one method
 * that can end a run — is the same move as `watchReemergence`: ask the question
 * twice, once from inside and once from outside, and a disagreement is a bug in
 * whichever one is lying.
 */
function watchCaptures(world, tally) {
  const capture = world._capture.bind(world)
  world._capture = () => {
    const drawn = world.streetView.worldOf(world.creaturePosition)
    tally.captureEvents.push({
      at: tally.clock,
      state: world.creature.state,
      tier: world.creature.tier,
      finale: world.state.finale === true,
      gap: Math.hypot(beast.wrapDelta(world.player.pos.x, drawn.x), beast.wrapDelta(world.player.pos.z, drawn.z)),
    })
    capture()
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
    closest: Infinity,
    inReach: 0,
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
  tally.current = null
}

/**
 * The closest the thing ever got, in metres — the number that decides whether §7.4's
 * hammer is a tool or a decoration.
 *
 * §7.4's banish needs contact inside `BANISH_RANGE`, so a run in which the
 * creature never arrives is a run in which the ladder never moves, and §11.3's
 * first trend has no mechanism behind it. The closest approach is therefore a
 * first-class measurement rather than a debugging leftover: it is the difference
 * between "the banish is expensive" and "the banish is unreachable".
 */
function reachOf(world) {
  const drawn = world.streetView.worldOf(world.creaturePosition)
  return Math.hypot(beast.wrapDelta(world.player.pos.x, drawn.x), beast.wrapDelta(world.player.pos.z, drawn.z))
}

/** One frame of measurement, taken after the world's own update. */
function tallyFrame(tally, world, dt) {
  const state = world.creature.state
  tally.states.add(state)
  const present = ON_FIELD.includes(state)
  const reach = present ? reachOf(world) : Infinity
  if (reach < tally.closest) {
    tally.closest = reach
    tally.closestState = state
    tally.closestFinale = world.state.finale === true
  }
  if (present && reach < beast.BANISH_RANGE && beast.BANISHABLE_STATES.includes(state)) tally.inReach += dt
  if (tally.current) {
    if (reach < tally.current.closest) tally.current.closest = reach
    if (reach < beast.BANISH_RANGE && beast.BANISHABLE_STATES.includes(state)) tally.current.inReach += dt
  }
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
  watchCaptures(world, tally)
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
    closest: tally.closest,
    closestState: tally.closestState,
    closestFinale: tally.closestFinale,
    inReach: tally.inReach,
    captureEvents: tally.captureEvents,
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
 * creature is thirty metres behind, and the car is up to four blocks away.
 *
 * THE HAMMER IS IN HAND, and that changed what this experiment can answer. It used
 * to be posed without one, on the reasoning that the only question §10.2 asks is the
 * one about the gap between 5.2 and 6.0. But §10.2's own next bullet is "banish
 * still works, but the ladder is ignored and re-emergence is a flat short delay. The
 * hammer must stay relevant or Act II's whole skill ceiling evaporates at the
 * climax", and a finale where the hammer has been taken off the table cannot fail if
 * the hammer is what the finale is about. A connected swing there is 1.6 s of
 * STAGGER plus `ENRAGED_REEMERGENCE_SECONDS` and a §8.3 placement 90 m away — three
 * seconds of standing still for a block and a half of head start, which is a far
 * better deal than any amount of sprinting, and precisely the intended answer.
 *
 * So the only variable left between the two runs is the one the design says the
 * finale is about: the gait. One player runs, one walks, and both have the hammer.
 */
function finaleRuns() {
  const runs = []
  for (const seed of SIM_SEEDS) {
    for (const sprint of [false, true]) {
      const base = sprint ? COMPETENT : CARELESS
      runs.push(
        playRun(seed, { ...base, label: `${base.label}-finale` }, {
          maxSeconds: 300,
          setup: (world) => {
            placePortals(world, hood.PORTAL_IDS.length)
            world.state = { ...world.state, hammerHeld: true }
            world.streetView.setHammerTaken(true)
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
            world._recentre()
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

/**
 * §11.3's first quantity, per encounter: the fraction of the player's own seconds
 * spent with the creature in the world.
 *
 * The denominator is the time until the NEXT encounter starts, not the time since
 * the last one did, and the difference is not cosmetic: a long hunt followed by a
 * banish has a long exposure and a short gap, so a backward-dated cycle divides by
 * less exposure than it had and reports a share above 1. The last encounter in a run
 * has no next one, so it is measured against the run's own remaining seconds.
 */
function actTwoOf(run) {
  const encounters = run.encounters.filter((encounter) => !encounter.finale)
  return encounters.map((encounter, index) => {
    const next = encounters[index + 1]
    const cycle = next ? next.start - encounter.start : Math.max(0, run.seconds - encounter.start)
    return { ...encounter, share: cycle > 0 ? encounter.onField / cycle : 1 }
  })
}

/**
 * pooledThirds — §11.3's two trends, bucketed by how far through the run each
 * encounter was, and pooled over every policy.
 *
 * The bucketing is *per run* and then pooled, and that order is the whole method:
 * a run is a run, and "later in the run" is only comparable inside one. A single
 * global bucket by encounter index would be comparing the first encounter of a
 * lucky run with the ninth of an unlucky one and calling the difference a trend.
 *
 * `share` is the fraction of the encounter's own cycle spent with the creature in
 * the world; `onField` is the raw exposure in seconds, which is §11.3's own wording
 * ("expected seconds of creature-on-field per encounter → decreasing"); `pursuit` is
 * the measured closing speed of the states that can end a run, which is §11.3's
 * second quantity ("damage per encounter → increasing") as a number rather than as a
 * word; and `banish` is the §7.4 rung the encounter began on, which is the *mechanism*
 * trend 1 is supposed to run through. A trend that holds without the mechanism moving
 * is a coincidence, so the checks below assert the mechanism too.
 *
 * @param {object[]} runs from `fullRuns`
 * @returns {{third:number, count:number, share:number[], onField:number[],
 *   cycle:number[], pursuit:number[], banish:number[], captures:number}[]}
 */
function pooledThirds(runs) {
  const perThird = new Map()
  for (const run of runs) {
    const encounters = actTwoOf(run)
    for (let i = 0; i < encounters.length; i += 1) {
      const third = Math.min(2, Math.floor((i / Math.max(1, encounters.length)) * 3))
      const bucket = perThird.get(third) ?? {
        third, share: [], onField: [], cycle: [], pursuit: [], banish: [], captures: 0, count: 0,
      }
      bucket.count += 1
      bucket.share.push(encounters[i].share)
      bucket.onField.push(encounters[i].onField)
      bucket.cycle.push(encounters[i].cycle)
      bucket.pursuit.push(encounters[i].pursuit)
      bucket.banish.push(encounters[i].banish)
      bucket.captures += encounters[i].captured ? 1 : 0
      perThird.set(third, bucket)
    }
  }
  return [...perThird.values()].sort((a, b) => a.third - b.third)
}

function reportBalance(sim) {
  const line = (text) => console.log(text)
  line('')
  line(`  balance simulation — ${sim.plays} runs in ${sim.milliseconds} ms`)
  line('')
  line('  full runs')
  for (const run of sim.runs) {
    line(
      `    ${run.plan.padEnd(9)} seed ${run.seed}  ${run.won ? 'WON ' : 'lost'}  captures ${run.captures}/${run.captureEvents.length}  ` +
        `portals ${run.portalsShut}  banishes ${run.banishes}  hammer ${run.hammerAt === null ? 'never' : `${run.hammerAt.toFixed(0)}s`}  ` +
        `encounters ${run.encounters.length}  on-field ${(run.onFieldSeconds / run.seconds * 100).toFixed(0)}%  ` +
        `closest ${run.closest.toFixed(1)}m/${run.closestState ?? '-'}${run.closestFinale ? '(fin)' : ''}  in reach ${run.inReach.toFixed(1)}s  ` +
        `finale ${run.finaleSeconds.toFixed(0)}s  ${run.seconds.toFixed(0)}s`,
    )
  }
  line('')
  line('  §11.3 by encounter index (competent runs, Act II only)')
  const perIndex = new Map()
  for (const run of sim.runs) {
    if (run.plan !== 'competent') continue
    for (const encounter of actTwoOf(run)) {
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
  line('  §11.3 pooled into thirds of each run (every policy, Act II only)')
  for (const bucket of pooledThirds(sim.runs)) {
    line(
      `    third ${bucket.third + 1}  n=${String(bucket.count).padStart(3)}  share ${mean(bucket.share).toFixed(3)}  ` +
        `on-field ${mean(bucket.onField).toFixed(1)}s  cycle ${mean(bucket.cycle).toFixed(1)}s  ` +
        `pursuit ${mean(bucket.pursuit).toFixed(2)} m/s  banish #${mean(bucket.banish).toFixed(2)}  captured ${bucket.captures}/${bucket.count}`,
    )
  }
  line('  §11.3 by banish rung (competent runs, Act II only)')
  const perRung = new Map()
  for (const run of sim.runs) {
    if (run.plan !== 'competent') continue
    for (const encounter of actTwoOf(run)) {
      const rung = Math.min(5, encounter.banish + 1)
      const bucket = perRung.get(rung) ?? { rung, share: [], onField: [], cycle: [], count: 0 }
      bucket.count += 1
      bucket.share.push(encounter.share)
      bucket.onField.push(encounter.onField)
      bucket.cycle.push(encounter.cycle)
      perRung.set(rung, bucket)
    }
  }
  for (const bucket of [...perRung.values()].sort((a, b) => a.rung - b.rung)) {
    line(
      `    banish ${bucket.rung}  n=${String(bucket.count).padStart(3)}  share ${mean(bucket.share).toFixed(3)}  ` +
        `on-field ${mean(bucket.onField).toFixed(1)}s  cycle ${mean(bucket.cycle).toFixed(1)}s  window ${beast.banishDuration(bucket.rung)}s`,
    )
  }
  line('  §11.3 by tier (competent runs, Act II only)')
  const perTier = new Map()
  for (const run of sim.runs) {
    for (const encounter of actTwoOf(run)) {
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
  line('  the finale (§10.2): 30 m behind, hammer in hand, car up to four blocks away — gait is the only variable')
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

check('§11.3 trend 1: the banish ladder buys quiet, so on-field time falls over a run', () => {
  const sim = simulation()
  const thirds = pooledThirds(sim.runs)
  assert.equal(thirds.length, 3, 'every run contributed to all three thirds')
  const shares = thirds.map((bucket) => mean(bucket.share))
  const exposure = thirds.map((bucket) => mean(bucket.onField))
  // §11.3's first trend, in §11.3's own words first: "expected seconds of
  // creature-on-field per encounter → decreasing". The margin here is a factor of
  // two and a half, not a rounding error, which is what makes it a gate.
  assert.ok(
    exposure[2] < exposure[0] * 0.6,
    `on-field seconds did not fall over a run: ${exposure.map((v) => v.toFixed(1)).join(' -> ')}s`,
  )
  assert.ok(exposure[1] < exposure[0], 'and they fall monotonically, not on average')
  assert.ok(exposure[2] < exposure[1], 'and they are still falling in the last third')
  // and the same trend as a *share* of the encounter cycle, which is the stricter
  // reading: the exposure has to fall faster than the cycle it is measured against,
  // or the creature is simply spending longer over a shorter walk. It was RISING
  // (0.830 / 0.888 / 0.908) for the whole of the previous tuning pass, and the two
  // reasons are the two this slice fixed: §6.2's sound table was being read at zero
  // metres, so the creature was permanently acquired, and the hammer was never in
  // reach, so §7.4's ladder never bought a second of quiet.
  assert.ok(
    shares[2] < shares[1] && shares[1] < shares[0],
    `on-field share did not fall monotonically: ${shares.map((v) => v.toFixed(3)).join(' -> ')}`,
  )
  assert.ok(
    shares[2] < shares[0] * 0.95,
    `and it did not fall by a margin worth gating: ${shares.map((v) => v.toFixed(3)).join(' -> ')}`,
  )
  // THE MECHANISM, and this is the assertion that actually pins §7.4 down. A trend
  // that holds while the ladder sits still is a coincidence, so the rung the
  // encounter *began* on has to climb. It used to read 0.00 in all three thirds: the
  // competent policy swung, and the hammer connected zero times in eight full runs.
  const rungs = thirds.map((bucket) => mean(bucket.banish))
  assert.ok(
    rungs[2] > rungs[0] + 0.5,
    `§7.4's ladder did not climb over a run: ${rungs.map((v) => v.toFixed(2)).join(' -> ')}`,
  )
  assert.ok(rungs[1] > rungs[0] && rungs[2] > rungs[1], 'and it climbs monotonically')
  // the ladder is the *only* thing that can buy this, so a run that never swings
  // must show the exposure it would have had. The careless policy never swings.
  const swings = sim.runs.filter((run) => run.banishes > 0)
  const quiet = sim.runs.filter((run) => run.banishes === 0)
  assert.ok(swings.length > 0, 'at least one run climbed the ladder at all')
  assert.ok(quiet.length > 0, 'and at least one never touched it, or the comparison is empty')
  const shareOf = (rows) => mean(rows.map((run) => mean(actTwoOf(run).map((e) => e.share))))
  assert.ok(
    shareOf(swings) < shareOf(quiet),
    `banishing bought nothing: ${shareOf(swings).toFixed(3)} with a hammer vs ${shareOf(quiet).toFixed(3)} without`,
  )
})

check('a competent player wins every seed, and only by playing well', () => {
  const sim = simulation()
  const competent = sim.runs.filter((run) => run.plan === 'competent')
  assert.equal(competent.length, SIM_SEEDS.length, 'one run per seed')
  for (const run of competent) {
    assert.ok(run.won, `seed ${run.seed}: the competent player lost after ${run.seconds.toFixed(0)}s`)
    assert.equal(run.portalsShut, hood.PORTAL_IDS.length, `seed ${run.seed}: and did not finish its portals`)
    // and won *cleanly*: §9.1's promise is that a capture costs you where you were
    // and nothing else, so a competent player who is never caught is a far stronger
    // statement than one who is caught and walks on. This is the assertion that
    // caught the seed-8 degeneracy: an ENRAGED creature stood inside the player for
    // 508 s, inside BANISH_RANGE and outside CAPTURE_RADIUS's frame, and the run
    // was lost rather than won.
    assert.equal(run.captures, 0, `seed ${run.seed}: the competent player was caught ${run.captures} time(s)`)
    assert.ok(run.banishes > 0, `seed ${run.seed}: won without ever swinging the hammer`)
    assert.notEqual(run.hammerAt, null, `seed ${run.seed}: never found the hammer`)
    assert.ok(run.actOneSeconds > 0, `seed ${run.seed}: no Act I to speak of`)
    // and the closest the thing ever got is a number a hammer can answer, which is
    // the difference between §7.4 being a tool and §7.4 being a decoration
    assert.ok(run.closest <= beast.BANISH_RANGE * 4, `seed ${run.seed}: it never got near enough to swing (${run.closest.toFixed(1)}m)`)
  }
})

check('§11.3 trend 2: the aggression ladder bites harder over the same run', () => {
  const sim = simulation()
  const thirds = pooledThirds(sim.runs)
  const pursuit = thirds.map((bucket) => mean(bucket.pursuit))
  // §11.3's second trend, "damage per encounter → increasing", measured as the
  // speed at which the states that can end a run are actually closing. It is a
  // measurement rather than a table read: metres a second, divided out of the same
  // frames the player spent being hunted.
  assert.ok(
    pursuit[2] > pursuit[0] * 1.5,
    `damage did not rise over a run: ${pursuit.map((v) => v.toFixed(2)).join(' -> ')} m/s`,
  )
  assert.ok(pursuit[1] > pursuit[0] && pursuit[2] > pursuit[1], 'and it rises monotonically')
  // the top of the ramp is the ceiling §8.6 asks for, so the last third of a run has
  // to be running near it rather than merely above the first. It is not *at* it,
  // because this is a mean over every frame spent being pursued and a locked leg
  // spends some of those turning a corner; 0.85 is the share of the ceiling a
  // straight-line measure of a street-graph walk actually keeps.
  assert.ok(
    pursuit[2] >= beast.SPEED_CEILING * 0.85,
    `the last third never neared the ramp's top speed: ${pursuit[2].toFixed(2)} against ${beast.SPEED_CEILING} m/s`,
  )
  // and the two axes are opposed rather than aligned, which is the whole of §7.4's
  // "you are buying time, and the price is that the thing returns faster, sooner and
  // more aware": the same encounters that got quieter got faster.
  assert.ok(
    mean(thirds[2].share) < mean(thirds[0].share),
    'the last third of a run is both quieter and faster',
  )
})

check('the finale is escapable only by sprinting (§10.2)', () => {
  const sim = simulation()
  const sprinting = sim.finale.filter((run) => run.plan === 'competent-finale')
  const walking = sim.finale.filter((run) => run.plan === 'careless-finale')
  assert.equal(sprinting.length, SIM_SEEDS.length, 'one run per seed')
  assert.equal(walking.length, SIM_SEEDS.length, 'and one walker per seed')
  // §10.2's premise is arithmetic: 5.2 m/s against a 3.6 m/s walk is 1.6 m/s of
  // ground lost a second, from thirty metres back, which is nineteen seconds. A
  // walker is therefore caught long before a car four blocks away, and the harness
  // measures the capture rather than trusting the multiplication.
  const caughtWalking = walking.filter((run) => run.captures > 0)
  assert.ok(
    caughtWalking.length > walking.length / 2,
    `a walker was only caught in ${caughtWalking.length} of ${walking.length} seeds`,
  )
  for (const run of walking) {
    assert.ok(run.finaleSeconds > 0, 'the finale pose actually posed a finale')
    if (run.won) {
      assert.ok(run.captures > 0, `seed ${run.seed}: a walker reached the car without ever being caught`)
    }
  }
  // ...and the contrast, which is the claim "only by sprinting" actually makes. A
  // runner is never caught: 6.0 against 5.2 is a gap that opens, and the hammer is
  // there for the moment it closes — a connected swing in the finale is 1.6 s of
  // STAGGER plus `ENRAGED_REEMERGENCE_SECONDS` and a §8.3 placement ninety metres
  // away, which is three seconds of standing still for a block and a half of head
  // start, and is the better deal than any amount of running.
  //
  // What is NOT claimed, because the measurement does not support it, is that a
  // runner gets to the car sooner. It does not, reliably: the runner spends its
  // time on the hammer and the walker spends its time being caught, and §9.1 says a
  // capture costs you where you were and nothing else, so the two costs are drawn
  // from the same budget. The finale is decided by captures, which is exactly what
  // the assertion below is about, and the seconds are reported rather than gated.
  for (const run of sprinting) {
    assert.equal(run.captures, 0, `seed ${run.seed}: a runner was caught in the finale`)
    assert.ok(run.won, `seed ${run.seed}: a runner failed to reach the car`)
  }
  assert.ok(
    caughtWalking.length > sprinting.filter((run) => run.captures > 0).length,
    `walking was caught in ${caughtWalking.length} seeds and running in 0, which is not a difference`,
  )
  // and the runner is the one that gets to keep going: never caught, and it reached
  // the car in every seed, which the walker also manages — but only ever after
  // paying for it. The design's finale is a survivable walk for a walker and a
  // clean run for a sprinter, and §8.6's "running is loud" is why the first is not
  // a victory.
  for (const run of walking) {
    assert.ok(run.won || run.captures > 0, `seed ${run.seed}: a walker neither won nor was caught`)
  }
})

check('§8.1: the recklessly sprinting player cannot be caught before the hammer', () => {
  const sim = simulation()
  assert.equal(sim.actOne.length, SIM_SEEDS.length, 'one Act I per seed')
  for (const run of sim.actOne) {
    // §8.1's first rule: "Act I cannot kill you. TELEGRAPH has no capture path at
    // all." The policy here is the worst one the harness can express — it sprints at
    // the thing, into its face, for the whole of the pre-hammer phase — and it is
    // measured by the world's own `_capture`, wrapped, rather than by the loop
    // counter the reset takes a second to move.
    assert.equal(run.captures, 0, `seed ${run.seed}: caught ${run.captures} time(s) before the hammer`)
    assert.equal(run.captureEvents.length, 0, `seed ${run.seed}: the world decided on ${run.captureEvents.length} capture(s)`)
    assert.notEqual(run.hammerAt, null, `seed ${run.seed}: the run never ended, so nothing was measured`)
    // the sighting is the whole of Act I: the apparition is there to be seen and it
    // cannot be anything else, so its presence is asserted too
    for (const state of run.states) {
      assert.ok(
        ['telegraph', 'dormant'].includes(state),
        `seed ${run.seed}: Act I put the creature in ${state}`,
      )
    }
  }
})


/**
 * Rec. 709 relative luminance, 0-255, of a live material's colour.
 *
 * The same formula as pass 1's `relLuma` in `verify.mjs`, read off a
 * `THREE.Color` instead of out of a source file. `getHex()` converts the
 * material's working-space colour back to sRGB first, so the number here is the
 * same number pass 1's palette pins are made of and the two sections are
 * comparable rather than merely similar.
 */
function materialLuma(material) {
  const hex = material.color.getHex()
  return 0.2126 * ((hex >> 16) & 0xff) + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff)
}

check('the portal is a hole with a lit lip, not a halo (iteration 2, pass 3)', () => {
  // §12.2's cold light, read off the real scene graph of all three shells. The
  // complaint pass 3 answers is visible in one line of §16.5.5: a 16 cm cyan
  // hoop with the lit inside of the shed showing through the middle of it.
  game.restart()
  run(game, 0.5)
  for (const portal of game.streetView.portals) {
    const where = `${portal.id} (${portal.structure})`
    const disc = portal.disc.geometry.parameters
    const rim = portal.rim.geometry.parameters
    // the shape: a disc, and a torus sitting on its edge
    assert.equal(portal.disc.geometry.type, 'CircleGeometry', `${where} has no disc in its opening`)
    assert.equal(portal.rim.geometry.type, 'TorusGeometry', `${where} has no lip`)
    assert.equal(disc.radius, rim.radius, `${where}'s lip is not on the edge of its hole`)
    // the lip is a lip: BEFORE the tube was 0.08 on a 0.78 radius (10.3%), and
    // a band that thick is a ring no matter what is behind it
    assert.ok(rim.tube / rim.radius < 0.06, `${where}'s lip is ${((rim.tube / rim.radius) * 100).toFixed(1)}% of the radius — that is a hoop again`)
    // the hole is behind its own lip, in the gate's frame, which is the reading:
    // something a little way *into* the doorway with an edge standing in front
    assert.ok(portal.disc.position.z < 0, `${where}'s hole is proud of its own lip`)
    // and the four parts are *in the scene graph*, which is not the same claim as
    // being on the record and is the one §16.1's mutation run caught the gate
    // missing: a disc that is built, named, stored on the portal and measured by
    // every other assertion in this check is still not drawn, because a mesh off
    // the graph is a perfectly good object. `parent` is the only thing that
    // separates the two.
    assert.equal(portal.gate.parent, portal.root, `${where}'s gate is not on its own root`)
    for (const [label, mesh] of [['hole', portal.disc], ['lip', portal.rim], ...portal.swirl.map((layer, index) => [`swirl ${index}`, layer])]) {
      assert.equal(mesh.parent, portal.gate, `${where}'s ${label} is not in the gate, so it is not in the world`)
    }
    // ...and it is a hole: near-black, where the lip is the same cyan it has
    // always been. §12.2 is unchanged — this is the *cold family* still being
    // the only cold light in the game, not a second lamp.
    assert.ok(
      materialLuma(portal.disc.material) < materialLuma(portal.rim.material) * 0.12,
      `${where}'s hole is ${((materialLuma(portal.disc.material) / materialLuma(portal.rim.material)) * 100).toFixed(1)}% of its lip's luma — a dark lamp, not a hole`,
    )
    assert.equal(portal.rim.material.fog, false, `${where}'s lip fogs out, so §4's long-range tell is gone at 40 m`)
    assert.equal(portal.disc.material.fog, false, `${where}'s hole fades to the fog colour with distance, which is the one thing a hole must not do`)
    // the swirl: two layers, both strictly inside the hole, both additive, both
    // in the lip's own colour — one family, four meshes, one texture
    assert.equal(portal.swirl.length, 2, `${where} has ${portal.swirl.length} swirl layers, not two`)
    const depths = portal.swirl.map((layer) => layer.position.z)
    for (const [index, layer] of portal.swirl.entries()) {
      assert.equal(layer.geometry.type, 'CircleGeometry', `${where}'s layer ${index} is not a disc`)
      assert.ok(
        layer.geometry.parameters.radius < disc.radius,
        `${where}'s layer ${index} is wider than the hole it turns in, so it draws an edge the hole does not have`,
      )
      assert.equal(layer.material.transparent, true, `${where}'s layer ${index} is opaque`)
      assert.equal(layer.material.depthWrite, false, `${where}'s layer ${index} occludes the layer under it`)
      assert.equal(layer.material.blending, THREE.AdditiveBlending, `${where}'s layer ${index} paints over the hole instead of adding to it`)
      assert.equal(
        layer.material.color.getHex(),
        portal.rim.material.color.getHex(),
        `${where}'s layer ${index} is not the lip's light, so the opening has two colours in it`,
      )
      assert.ok(depths[index] > portal.disc.position.z, `${where}'s layer ${index} is behind its own hole`)
      assert.ok(depths[index] < 0, `${where}'s layer ${index} is proud of its own lip`)
    }
    assert.notEqual(depths[0], depths[1], `${where}'s two layers are coincident, so one of them is a decal`)
    // and the two are the same texture, which is what makes the pair read as one
    // thing at two scales rather than as two things
    assert.equal(portal.swirl[0].material, portal.swirl[1].material, `${where} built its swirl in two materials`)
  }
})

check('the swirl turns on the world clock, slowly, and stops when the portal is shut', () => {
  game.restart()
  run(game, 0.5)
  const street = game.streetView
  const portal = street.portals[0]
  // half a second of the real world clock, which is what `capture.js` would also
  // have advanced between two of its frames
  const before = portal.swirl.map((layer) => layer.rotation.z)
  const beforeScale = portal.gate.scale.x
  run(game, 0.5)
  const after = portal.swirl.map((layer) => layer.rotation.z)
  const turned = after.map((value, index) => value - before[index])
  for (const [index, delta] of turned.entries()) {
    assert.notEqual(delta, 0, `${portal.id}'s layer ${index} stood still through half a second of the world`)
    // slow enough to outlast the verb: §5.3's shutdown is a held breath, and a
    // layer that came all the way round inside one would be a machine
    assert.ok(Math.abs(delta) < 0.35 * 0.5, `${portal.id}'s layer ${index} turned ${delta.toFixed(3)} rad in 0.5 s — that is machinery, not a hole`)
  }
  // and against itself: two layers turning the same way read as one disc with a
  // pattern painted on it, which is exactly what pass 3 was not asked to build
  assert.notEqual(Math.sign(turned[0]), Math.sign(turned[1]), `${portal.id}'s two layers turn the same way`)
  // the gate breathes with them, as one object — BEFORE pass 3 the ring swelled
  // alone and there was nothing else in the opening to breathe with it
  assert.notEqual(portal.gate.scale.x, beforeScale, `${portal.id}'s gate is not breathing any more`)
  assert.ok(
    Math.abs(portal.gate.scale.x - portal.gateScale) < 0.04,
    `the gate is scaled ${portal.gate.scale.x.toFixed(3)} against its structure's own ${portal.gateScale} — the swell is not folded in`,
  )
  // §5.3: a shut portal is inert, and "inert" is a claim about motion, not about
  // a material. This is the check the material assertions cannot make.
  assert.equal(street.setPortalShut(portal.id, true), true)
  const dead = portal.swirl.map((layer) => layer.rotation.z)
  const deadScale = portal.gate.scale.x
  run(game, 0.5)
  for (const [index, layer] of portal.swirl.entries()) {
    assert.equal(layer.rotation.z, dead[index], `${portal.id}'s layer ${index} is still turning in a dead portal`)
    assert.equal(layer.visible, false, `${portal.id}'s layer ${index} is still drawn in a dead portal`)
  }
  assert.equal(portal.gate.scale.x, deadScale, `${portal.id}'s gate is still breathing after the shutdown`)
  // and §5.3 is one-way *for the run*, not for the view layer: `restart()` is
  // the one caller that un-shuts, and it has to put the motion back too, or a
  // second loop photographs dead spirals in a live hole
  assert.equal(street.setPortalShut(portal.id, false), true)
  run(game, 0.5)
  for (const [index, layer] of portal.swirl.entries()) {
    assert.notEqual(layer.rotation.z, dead[index], `${portal.id}'s layer ${index} never came back`)
    assert.equal(layer.visible, true, `${portal.id}'s layer ${index} never came back lit`)
  }
})

check('a camera on the §16.5.5 stand-off sees the hole, and not through it', () => {
  // The one check in this file that asks a question only a scene graph can
  // answer. §16.5.5's two portal views stand 4.5 m and 2.2 m out on the
  // structure's own `facing`, so 4.5 m is the furthest and is the number that
  // has to work. If a shell is in front of its own gate — which it was for the
  // phone box, whose cube is solid and whose ring was sealed inside it at the
  // origin — then the first thing in this ray is a metal wall, and the capture
  // is a photograph of the *absence* of a portal, which is the failure the
  // shed's lintel comment records having already happened to the shed once.
  //
  // Nothing in the *street* is tested for occlusion, and that is not a gap:
  // `capture.js`'s own `place()` refuses any stand-off a fixture blocks, and
  // §3.6 rule 3 reserves the middle third of a lot, which is where these anchors
  // are. This checks the part that was never checked — the portal's own geometry
  // against itself.
  game.restart()
  run(game, 0.5)
  // The one thing a real renderer would have done for us, and the reason this
  // check needed a line of its own: a stubbed `render()` never calls
  // `updateMatrixWorld`, so in this harness every mesh's world matrix is still
  // the identity unless something asks for it. `getWorldPosition` below fixes
  // the *gate's* chain and leaves the disc, the lip and the two swirl layers
  // behind, which is why the ray came back empty until this line.
  game.scene.updateMatrixWorld(true)
  for (const portal of game.streetView.portals) {
    const where = `${portal.id} (${portal.structure})`
    const target = portal.gate.getWorldPosition(new THREE.Vector3())
    const from = target.clone().add(new THREE.Vector3(portal.facing.x, 0, portal.facing.z).multiplyScalar(4.5))
    const ray = new THREE.Raycaster(from, target.clone().sub(from).normalize(), 0, 4.6)
    const hits = ray.intersectObject(portal.root, true)
    // **ONLY HITS THAT WOULD ACTUALLY BE DRAWN COUNT, and pass 12 is why.** The
    // gate gained a collapse group — a second aperture, two meshes — which is
    // `visible = false` until a shutdown arms it, and three.js's `Raycaster` does
    // not skip invisible objects: it raycasts them anyway. So a 0.72 m disc at the
    // gate plane became the first hit of a camera standing at 4.5 m, and this
    // check reported that "the shell is in front of its own opening" — which is
    // both false and, worse, indistinguishable from the real bug it was written to
    // catch. The shed lintel comment records that exact failure happening once
    // already.
    //
    // The filter walks the whole ancestor chain, not just the hit object: a mesh
    // under a hidden GROUP is not drawn either, and the collapse's two meshes are
    // both in that situation. Before pass 12 every child of `root` was visible, so
    // this changes no existing verdict — it only stops the new ones from being
    // measured, which is the definition of a correct fix rather than a convenient
    // one.
    const drawn = hits.filter((hit) => {
      for (let node = hit.object; node; node = node.parent) {
        if (node.visible === false) return false
      }
      return true
    })
    assert.ok(drawn.length > 0, `${where}: there is nothing at all between a camera on the stand-off and the gate`)
    const first = drawn[0].object
    assert.ok(
      [portal.disc, portal.rim, ...portal.swirl].includes(first),
      `${where}: the first thing a camera sees is ${first.name || first.type}, not the gate — the shell is in front of its own opening`,
    )
    // ...and it stops at the opening rather than at the far side of the
    // structure: the gate plane is 4.5 m out and the lip is 2.8 cm of tube on it
    assert.ok(
      4.4 < drawn[0].distance && drawn[0].distance < 4.55,
      `${where}: the camera is stopped ${drawn[0].distance.toFixed(2)} m out, which is not the gate plane at 4.50 m`,
    )
    // The three openings are three different sizes, which is §5.1's list being
    // worth having — and each one is bounded by something real. The shed's hole
    // is *wider* than the 1.3 m doorway, so the frame crops it and the frame is
    // the doorway's. The phone box's is *narrower* than the 1.1 m face it is
    // stuck to, or the booth becomes a disc with a booth behind it. The shelter's
    // is free-standing at full size, because a shelter is open on three sides and
    // there is nothing there to crop it — which is exactly the difference between
    // the three shells that §5.1's list is for.
    const across = portal.disc.geometry.parameters.radius * 2 * portal.gate.scale.x
    const bounds = { shed: [1.3, Infinity], busShelter: [0, Infinity], phoneBox: [0, 1.1] }
    const [low, high] = bounds[portal.structure]
    assert.ok(
      across > low && across < high,
      `${where}'s hole is ${across.toFixed(2)} m across, outside the (${low}, ${high}) its shell can hold`,
    )
  }
})

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 5 — BUILDING DEPTH
//
// WHAT ONLY THIS FILE CAN ASK
// --------------------------
// `verify.mjs` reads `streetView.js` as TEXT, so everything it can say about this
// pass is a claim about source: that a constant exists, that a call is made, that
// a forbidden string is absent. Four of the pass's five claims are of that kind
// and they are checked there. The fifth is not, and it is the one the pass is
// actually about:
//
//   **every instance in a pool carries the colour its lot asked for.**
//
// That is a statement about 588 floats in a buffer, and AESTHETIC-NOTES §4 is
// explicit that a check which only asserted "the material is not undefined" would
// have passed the pre-pass-5 code — the trap the pass-3 reviewer already fell into
// once, when the luma gate passed a picture of a wall. So this section does the
// strong version: it reads back the instance colour buffer, groups it into the
// four `PALETTE.siding` entries, and requires the histogram to be EXACTLY the
// histogram `neighborhood.js` says the world should have.
//
// An exact histogram is the point. "More than one colour" would pass a world
// where one lot in 588 was correct. An exact count per tint, over three wrapped
// copies, is a claim the old code fails and only the old code fails.
// ---------------------------------------------------------------------------

check('every house instance carries its own lot\'s colour (iteration 2, pass 5)', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const mesh = view.pools.houses.mesh
  // The precondition, and the whole mechanism: an `InstancedMesh` with a
  // non-null `instanceColor` is the only way one pool can hold two colours. A
  // check that skipped this would pass on a pool with a `setColorAt` call and a
  // `needsUpdate` that never fired, which renders every instance at the first
  // instance's colour — the old bug, moved from the material slot to the buffer.
  assert.notEqual(mesh.instanceColor, null, 'the houses pool has no instanceColor buffer at all')
  assert.equal(
    mesh.instanceColor.count, mesh.instanceMatrix.count,
    'the colour buffer and the matrix buffer are different sizes, so the two are not parallel',
  )
  assert.equal(mesh.count, view.pools.houses.used, 'the pool committed a different count than it placed')

  // The expected histogram, derived from the PURE module and nothing else. This
  // is deliberately not re-reading `streetView.js`: if the view and this count
  // disagree because the view changed, this test is what says so.
  const anchors = new Set(view.anchorLots)
  const perTint = new Map()
  for (let cx = 0; cx < hood.GRID; cx += 1) {
    for (let cz = 0; cz < hood.GRID; cz += 1) {
      for (const lot of hood.chunkAt(view.seed, cx, cz).lots) {
        if (lot.kind !== 'house') continue
        if (anchors.has(`${cx},${cz},${lot.side}`)) continue
        // `SIDE_NAMES.length * WRAP_COPIES.length` = 4 lots x 3 copies per chunk,
        // but only the house lots and only the non-anchor ones, so the multiplier
        // is the three wrapped copies and the filter is the rest.
        perTint.set(lot.tint % 4, (perTint.get(lot.tint % 4) ?? 0) + 3)
      }
    }
  }

  // The measured histogram, read back off the buffer in LINEAR floats. The buffer
  // holds linear-sRGB, so each sample is compared against the linear value of the
  // palette entry rather than the 8-bit hex: comparing a float to 0x3a3540 would
  // be comparing 0.042 to 3,816,384 and the test would pass by being zero.
  const measured = new Map()
  const array = mesh.instanceColor.array
  for (let i = 0; i < mesh.count; i += 1) {
    const key = `${array[i * 3].toFixed(5)},${array[i * 3 + 1].toFixed(5)},${array[i * 3 + 2].toFixed(5)}`
    measured.set(key, (measured.get(key) ?? 0) + 1)
  }
  for (const [tint, want] of perTint) {
    // The palette is re-read from the live material's own four documented values
    // by re-deriving them through `THREE.Color`, which is the same conversion
    // `streetView.js` did, so this compares like with like.
    const colour = new THREE.Color(view.sidingPalette[tint])
    const key = `${colour.r.toFixed(5)},${colour.g.toFixed(5)},${colour.b.toFixed(5)}`
    assert.equal(
      measured.get(key) ?? 0, want,
      `tint ${tint} is on ${measured.get(key) ?? 0} houses and the generator says ${want} — ` +
        'the per-lot tint is not reaching the scene',
    )
  }
  // And nothing else is in there. A buffer with the right four counts AND a fifth
  // colour is a buffer something wrote by accident, and total equality is the only
  // statement that means "every instance carries its own lot's colour".
  assert.equal(
    [...measured.values()].reduce((a, b) => a + b, 0), mesh.count,
    'the colour buffer holds more entries than the pool placed',
  )
  assert.equal(measured.size, perTint.size, `the pool holds ${measured.size} distinct colours, not ${perTint.size}`)
})

check('hedge and fence are different materials in different pools, and both are used', () => {
  // The second half of the pre-pass-5 defect, and the one per-instance colour
  // could NOT fix: `frontage` was one pool holding both kinds with a rewritten
  // material slot, so every hedge in the world rendered as a fence or the other
  // way round. A colour would not have helped, because a hedge has a texture and
  // a fence does not and one material cannot be both — so the fix is structural
  // and the check has to be structural too.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  assert.equal(view.pools.frontage, undefined, 'the combined frontage pool is still here')
  const hedge = view.pools.frontageHedge
  const fence = view.pools.frontageFence
  assert.notEqual(hedge, undefined, 'there is no hedge pool')
  assert.notEqual(fence, undefined, 'there is no fence pool')
  assert.notEqual(hedge.mesh.material, fence.mesh.material, 'both frontage halves share one material')
  assert.notEqual(
    hedge.mesh.material.map, fence.mesh.material.map,
    'both frontage halves have the same map, so the hedge and the fence are the same texture',
  )
  // Both are non-empty. An empty pool is a pool that renders nothing, and the
  // pre-pass-5 bug could not be told apart from "the feature is switched off",
  // so "at least one of each" is the floor.
  assert.ok(hedge.used > 0, 'no hedge was placed anywhere in the world')
  assert.ok(fence.used > 0, 'no fence was placed anywhere in the world')
})

check('the roofline is a parapet and not a cone (AESTHETIC-NOTES mechanism 1)', () => {
  // The claim is a claim about SILHOUETTE, and the measurable form of it is that
  // the roof geometry has no slope: the topmost solid on a house is a box, and
  // the house's highest point is its parapet rather than a cone's apex. Before
  // the pass it was a `ConeGeometry(0.72, 1, 4)` at 1.9 m on a 5.2 m wall, and
  // `street.png` is a photograph of that.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  assert.equal(
    view.pools.roofs.mesh.geometry.type, 'BoxGeometry',
    'the roof is not a box, so a house still has a cone on it',
  )
  const parapet = view.pools.parapets
  assert.ok(parapet.used > 0, 'no parapet was placed anywhere')
  // The annulus is a UNIT shape, so an instance's scale IS its real dimensions.
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  parapet.mesh.getMatrixAt(0, matrix)
  matrix.decompose(position, quat, scale)
  assert.ok(scale.y > 0.2, `the parapet is ${scale.y.toFixed(2)} m tall, which is a lip rather than an upstand`)
  // ...and PAIRED with a house, which is the only way the claim can be made. The
  // pools are filled in build order, so instance 0 of one is not instance 0 of
  // the other — the first thing this check did was compare a 2.7 m garage's
  // parapet against a 5.2 m house's wall and fail on geometry that was correct.
  // So: every parapet's BASE sits on a house's or outbuilding's top, and the
  // house's silhouette is measured as that pair. This is also the stronger claim —
  // it says the parapet is ON the building, not merely that a parapet exists.
  const tops = new Map()
  for (const [name, pool] of [['house', view.pools.houses], ['outbuilding', view.pools.outbuildings]]) {
    for (let i = 0; i < pool.used; i += 1) {
      pool.mesh.getMatrixAt(i, matrix)
      matrix.decompose(position, quat, scale)
      tops.set(`${name}:${position.x.toFixed(2)},${position.z.toFixed(2)}`, position.y + scale.y / 2)
    }
  }
  let checked = 0
  let tallest = 0
  for (let i = 0; i < parapet.used; i += 1) {
    parapet.mesh.getMatrixAt(i, matrix)
    matrix.decompose(position, quat, scale)
    const key = `${position.x.toFixed(2)},${position.z.toFixed(2)}`
    const wallTop = tops.get(`house:${key}`) ?? tops.get(`outbuilding:${key}`)
    assert.notEqual(wallTop, undefined, `a parapet at (${key}) stands on nothing`)
    // The parapet's base is its own centre minus half its height, and that has to
    // BE the wall's top: a parapet floating 200 mm above a roof is a lid, and one
    // buried in the roof is a thicker roof. Only the float is tolerated, because
    // the deck between them is what the parapet stands on.
    const base = position.y - scale.y / 2
    assert.ok(
      base >= wallTop - 0.02 && base <= wallTop + 0.25,
      `a parapet's base is at ${base.toFixed(2)} m and the wall below it tops out at ` +
        `${wallTop.toFixed(2)} m — it is floating or buried, not standing on it`,
    )
    if (position.y + scale.y / 2 > tallest) tallest = position.y + scale.y / 2
    checked += 1
  }
  assert.equal(checked, parapet.used, 'not every parapet was checked')
  // And the composed silhouette: a house's highest point is its parapet, and it is
  // 340 mm above the wall. A cone's would have been 1.9 m above it and triangular.
  assert.ok(
    tallest > 5.2,
    `the tallest point of any building is ${tallest.toFixed(2)} m, which is not above a 5.2 m wall`,
  )
  // Roof clutter is what makes a roofline read as a place rather than a lid: two
  // boxes per house, and a roof with nothing on it is a lid.
  assert.ok(
    view.pools.roofClutter.used >= view.pools.houses.used * 2,
    `the roofs carry ${view.pools.roofClutter.used} boxes for ${view.pools.houses.used} houses`,
  )
})

check('every window is a stack with a reveal, and the lit ones are rare (T3, D3)', () => {
  // T3's claim is about DEPTH ORDER, and the measurable form of a depth order in a
  // scene graph is each part's signed offset from its wall. So this reads the three
  // pools' instance matrices and checks the ORDER rather than reading the source:
  // pane behind the wall's face, frame proud of it, sill proudest of all. A
  // source check can only see that three calls exist; this sees which is where.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const glass = view.pools.windowGlass
  const lit = view.pools.windowLit
  const frames = view.pools.windowFrames
  const sills = view.pools.windowSills
  // The scratch objects are declared BEFORE the helper that closes over them,
  // because the first version of this check declared them after and the helper
  // was hoisted above them — a `const` in the temporal dead zone, thrown only when
  // the check ran, and only on the path that used the helper.
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  // Panes: every window is either dark or lit, and the two pools together ARE the
  // window count. This is the check that fails if `_addFacadeWindows` places a
  // frame with no pane behind it — a frame with nothing in it is a hole in the
  // wall, and it is the failure the whole ordering exists to prevent.
  const panes = glass.used + lit.used
  assert.ok(panes > 0, 'the world has no windows at all')
  assert.equal(frames.used, panes, `${frames.used} frames for ${panes} panes — a frame with nothing behind it`)
  assert.equal(sills.used, panes, `${sills.used} sills for ${panes} panes — one window has no sill on it`)

  // The stack, measured. The pools are compared as SETS of (height, width,
  // through-depth) rather than pairwise, because the two pane pools and the frame
  // pool are filled in different orders — a lit pane goes to one pool and a dark
  // one to another, so index 0 of `windowGlass` is not index 0 of `windowFrames`
  // and pairing them would be an accident of build order rather than a measurement.
  const shapes = (pool) => {
    const rows = []
    for (let i = 0; i < pool.used; i += 1) {
      pool.mesh.getMatrixAt(i, matrix)
      matrix.decompose(position, quat, scale)
      // Through-depth is the SMALLER of the two horizontal extents, which is what
      // a caller placing "w along the wall, d through it" produces whichever way
      // the wall happens to face.
      rows.push({
        y: position.y,
        x: position.x,
        z: position.z,
        // `face` is the AXIS the part is thin on, which is the axis its wall
        // faces, and it is read from the scale rather than inferred from which
        // extent is smaller. The first version of this check inferred the axis
        // from `through < along` and compared two lit windows 224 m apart on
        // different blocks, because "thin" does not say WHICH axis is thin.
        face: scale.x < scale.z ? 'x' : 'z',
        through: Math.min(scale.x, scale.z),
        along: Math.max(scale.x, scale.z),
      })
    }
    return rows
  }
  const paneRows = shapes(glass).concat(shapes(lit))
  const frameRows = shapes(frames)
  const sillRows = shapes(sills)
  const mean = (rows, pick) => rows.reduce((sum, row) => sum + pick(row), 0) / rows.length
  const paneThrough = mean(paneRows, (r) => r.through)
  const frameThrough = mean(frameRows, (r) => r.through)
  const sillThrough = mean(sillRows, (r) => r.through)
  // The frame is a THIN ring and the pane a THICKER slab: a frame as deep as its
  // pane is a block with a hole in it rather than a lip on a piece of glass.
  assert.ok(
    frameThrough < paneThrough,
    `the frame is ${frameThrough.toFixed(3)} m deep and the pane is ${paneThrough.toFixed(3)} m — ` +
      'the frame is not a lip on the glass',
  )
  // ...and the SILL is the proudest of the three, which is the part that catches
  // the sodium: it is the only part of a window that faces the sky, and T3's whole
  // point is the order "deepest thing first, sill proudest of all".
  assert.ok(
    frameThrough < sillThrough,
    `the frame is ${frameThrough.toFixed(3)} m deep and the sill is ${sillThrough.toFixed(3)} m — ` +
      'the sill is not the proudest part, which is the one that catches the sodium',
  )
  assert.ok(
    mean(frameRows, (r) => r.along) > mean(paneRows, (r) => r.along),
    'the frame is not wider than the pane, so the pane is not inside an opening',
  )

  // The lit rate. `LIT_WINDOW_ONE_IN` is 6, so this is a band rather than an
  // equality: the roll is per WALL and most walls roll no lit window at all, so
  // the measured rate over ~570 windows is a binomial around 1/6. A rate of zero
  // and a rate of 1/2 both fail, and both are the failures that look fine in a
  // screenshot: a street with no lit windows and a street of offices.
  const rate = lit.used / panes
  assert.ok(rate > 0.02, `only ${(rate * 100).toFixed(1)}% of windows are lit, which is not a variance at all`)
  assert.ok(rate < 0.4, `${(rate * 100).toFixed(1)}% of windows are lit, which is an office park`)

  // "Never two lit on the same façade" — checked GEOMETRICALLY, because a count
  // cannot tell you WHICH façade, and against a per-façade grouping rather than a
  // per-plane one, because coplanarity is not identity: two lots on the same block
  // side have CONTIGUOUS street walls, so a lit window on one house's wall and a
  // lit window on its neighbour's share a plane and a height and are still two
  // different façades. The first version of this check compared planes alone and
  // flagged a pair 224 m apart on different blocks; the second flagged a genuine
  // neighbouring pair. The grouping has to know which HOUSE a window is in, and
  // that is derived here from the house pool's own matrices rather than read off
  // the view's bookkeeping — a check that trusted the view's record of which
  // window it lit would be asking the code to grade itself.
  const houses = view.pools.houses
  const hmatrix = new THREE.Matrix4()
  const hposition = new THREE.Vector3()
  const hscale = new THREE.Vector3()
  const hquat = new THREE.Quaternion()
  // A house's four wall planes, keyed by the axis each one FACES. An x-facing wall
  // sits at `house.x ± scale.x / 2` and spans `scale.z` along z; a z-facing wall
  // sits at `house.z ± scale.z / 2` and spans `scale.x` along x. The two extents
  // are transposed and getting them the wrong way round is invisible on a square
  // and wrong on every other house — which is most of them, and is why the
  // transposition is written out rather than factored.
  const walls = { x: [], z: [] }
  for (let i = 0; i < houses.used; i += 1) {
    houses.mesh.getMatrixAt(i, hmatrix)
    hmatrix.decompose(hposition, hquat, hscale)
    for (const [face, normal, span] of [
      ['x', hscale.x, hposition.z],
      ['z', hscale.z, hposition.x],
    ]) {
      const centre = face === 'x' ? hposition.x : hposition.z
      const along = face === 'x' ? hscale.z : hscale.x
      for (const sign of [-1, 1]) {
        walls[face].push({ house: i, plane: centre + sign * normal / 2, span, extent: along })
      }
    }
  }
  const perFacade = new Map()
  for (const row of shapes(lit)) {
    // The wall plane is matched to the pane's own BOX, not to the pane's centre:
    // the pane is set `WINDOW.depth / 2` INTO the wall, so its centre is 40 mm
    // behind the plane and its outer face is exactly on it. Matching centres is
    // what made the first version of this find zero walls and report "the window
    // geometry and the façade geometry disagree" — which was a true statement
    // about a false comparison.
    const coord = row.face === 'x' ? row.x : row.z
    const free = row.face === 'x' ? row.z : row.x
    const candidates = walls[row.face].filter((wall) => (
      Math.abs(wall.plane - coord) <= row.through / 2 + 1e-3
      && Math.abs(wall.span - free) <= wall.extent / 2 + 1e-3
    ))
    assert.equal(
      candidates.length, 1,
      `a lit window at (${row.x.toFixed(2)}, ${row.z.toFixed(2)}) belongs to ${candidates.length} ` +
        'house walls, so it is on no wall at all — the façade geometry and the window geometry disagree',
    )
    // The key is the WALL, not the house: a house has two x-facing walls and two
    // z-facing ones, so `(face, house)` alone is two façades reported as one. The
    // first version of this check did that and reported a false violation on house
    // 96, which is a house whose left flank and right flank are both lit — legal,
    // because `_addFacadeWindows` rolls ONCE PER WALL and the rule is per façade.
    // The plane coordinate is in the key so the two flanks are told apart.
    const key = `${row.face}:${candidates[0].house}@${candidates[0].plane.toFixed(3)}`
    perFacade.set(key, (perFacade.get(key) ?? 0) + 1)
  }
  for (const [key, count] of perFacade) {
    assert.ok(
      count <= 1,
      `façade ${key} has ${count} lit windows — the emissive ladder says never two on one façade`,
    )
  }
  // ...and the rule is not vacuous: the world's lit windows really are spread
  // over many façades rather than concentrated on one, which is the difference
  // between "one roll per wall" and "one roll for the world".
  assert.ok(
    perFacade.size >= lit.used / 2,
    `${lit.used} lit windows are on only ${perFacade.size} façades, so several share one`,
  )
})

check('the entrance is a recess with steps, a canopy and a lamp under it', () => {
  // T-notes item 4's five parts, each checked BY COUNT against the house count,
  // which is the only way a check can tell that a part is on every house rather
  // than on one. A house with no door is a wall.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const houses = view.pools.houses.used
  assert.equal(view.pools.doorReveals.used, houses, 'not every house has a door reveal')
  assert.equal(view.pools.doorLeaves.used, houses, 'not every house has a door')
  assert.equal(view.pools.doorFrames.used, houses, 'not every house has a door surround')
  assert.equal(view.pools.entryLamps.used, houses, 'not every house has an entry lamp')
  assert.equal(view.pools.canopies.used, houses, 'not every house has a canopy')
  // Two steps per house, and every one ABOVE zero height. A step of zero height
  // is a rectangle painted on the ground and reads as a doormat, which is a
  // failure a count cannot see and a height check can.
  assert.equal(view.pools.steps.used, houses * 2, 'the step count is not two per house')
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  for (let i = 0; i < view.pools.steps.used; i += 1) {
    view.pools.steps.mesh.getMatrixAt(i, matrix)
    matrix.decompose(position, quat, scale)
    assert.ok(scale.y > 0.05, `step ${i} is ${(scale.y * 100).toFixed(0)} cm tall, which is a doormat`)
  }
  // The lamp is UNDER the canopy, which is the only reason the canopy is 400 mm
  // deep: a hood has to be able to catch its own lamp's light. Stated as a
  // comparison of two heights because that is the whole claim, and taken as a
  // MAXIMUM over the world so one badly hung lamp cannot hide behind a good one.
  let lampTop = 0
  let canopyBottom = Infinity
  for (let i = 0; i < view.pools.entryLamps.used; i += 1) {
    view.pools.entryLamps.mesh.getMatrixAt(i, matrix)
    matrix.decompose(position, quat, scale)
    lampTop = Math.max(lampTop, position.y + scale.y / 2)
  }
  for (let i = 0; i < view.pools.canopies.used; i += 1) {
    view.pools.canopies.mesh.getMatrixAt(i, matrix)
    matrix.decompose(position, quat, scale)
    canopyBottom = Math.min(canopyBottom, position.y - scale.y / 2)
  }
  assert.ok(
    lampTop < canopyBottom,
    `the entry lamps reach ${lampTop.toFixed(2)} m and the canopies start at ` +
      `${canopyBottom.toFixed(2)} m — the lamp is sticking through its own hood`,
  )
  // ...and the canopy PROJECTS, and is the only overhang on the street elevation,
  // so its depth is what makes it an overhang rather than a lintel drawn on a wall.
  let canopyDepth = 0
  for (let i = 0; i < view.pools.canopies.used; i += 1) {
    view.pools.canopies.mesh.getMatrixAt(i, matrix)
    matrix.decompose(position, quat, scale)
    canopyDepth = Math.max(canopyDepth, Math.min(scale.x, scale.z))
  }
  assert.ok(canopyDepth > 0.3, `the canopy projects ${canopyDepth.toFixed(2)} m, which is a lintel`)
  // ...and the emissive ladder, read off the LIVE materials rather than the
  // palette: `entryLamp` has to be the dimmest light in the game, or "the ladder"
  // is four names in a row. §12.2 puts the portal at the top, T11 at the bottom.
  const rungs = new Map([
    ['portal', materialLuma(view._materials.portal)],
    ['sodium', materialLuma(view._materials.sodium)],
    ['windowLit', materialLuma(view._materials.windowLit)],
    ['entryLamp', materialLuma(view._materials.entryLamp)],
  ])
  assert.ok(
    rungs.get('entryLamp') < rungs.get('sodium'),
    `the entry lamp is ${rungs.get('entryLamp').toFixed(1)} luma and a lamp head is ` +
      `${rungs.get('sodium').toFixed(1)} — the ladder's lowest rung is not the lowest`,
  )
  assert.ok(
    rungs.get('entryLamp') < rungs.get('portal'),
    'the entry lamp is not below the portal, so the two families are not ranked',
  )
  // ...and it is dim ENOUGH to be a rung and not merely lower. A rung one luma
  // below another is a rung that reads as the same light.
  assert.ok(
    rungs.get('sodium') - rungs.get('entryLamp') > 40,
    `the entry lamp is only ${(rungs.get('sodium') - rungs.get('entryLamp')).toFixed(1)} luma below a ` +
      'lamp head, which is not a step on a ladder',
  )
})

check('the per-lot part budget is met, and the worst lot is the number gated', () => {
  // T5: 588 lot instances, every per-lot part paid three times before anyone sees
  // it, and the number to gate on is the WORST lot rather than the mean, because
  // the mean hides the block whose four façades all face a street.
  //
  // The ceiling comes from `partBudget()` rather than from a number typed here or
  // parsed out of the source, so the gate cannot end up enforcing a budget the
  // file does not declare. `verify.mjs` pins the value; this measures against it.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const parts = view.partBudget()
  const budget = parts.budget
  assert.ok(Number.isInteger(budget) && budget > 0, 'the part budget did not come back with the measurement')
  assert.equal(
    parts.lots, hood.CHUNKS * hood.SIDE_NAMES.length * 3,
    `only ${parts.lots} lots were counted, so the instrument is broken`,
  )
  assert.ok(
    parts.max <= budget,
    `the worst lot places ${parts.max} parts and the budget is ${budget} (mean ${parts.mean.toFixed(1)}) — ` +
      'T5 says gate on the worst lot, so this is the number that matters',
  )
  // And the spread is non-zero, which is what stops this being a constant compared
  // with a constant: an anchor lot (no house, no door) and a maximal house are
  // different lots, and a measurement that cannot tell them apart is not measuring.
  assert.ok(parts.max > parts.min, 'every lot places the same number of parts, so the max proves nothing')
  // ...and the max is above the mean, which is T5's argument restated: if these
  // were equal, gating on the mean would have been correct and the note would not
  // have said otherwise.
  assert.ok(parts.max > parts.mean, 'the worst lot and the mean are identical, so the choice of statistic is moot')
})

check('no pool overflowed, and every pool is committed', () => {
  // Two failure modes that look identical on screen. A pool that is created and
  // never committed places instances into a buffer that is never uploaded: the
  // thing is simply missing and nothing reports it. A pool that overflows counts
  // the loss in `overflow` and the geometry is a hole in the world. Pass 5 added
  // thirteen pools, and a fourteenth would be caught here.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  for (const [name, pool] of Object.entries(view.pools)) {
    assert.equal(pool.overflow, 0, `${name} overflowed by ${pool.overflow} instances — the rest are holes in the world`)
    assert.equal(pool.mesh.count, pool.used, `${name} committed ${pool.mesh.count} of the ${pool.used} it placed`)
  }
  // ...and the commit list covers the pools. `streetPools` is the list the
  // creations and the commit loop BOTH read, so "declared == published" is now a
  // property of the code's shape rather than something two hand-written lists can
  // drift on. The gate still checks it, because the alternative is trusting the
  // shape, and `verify-world.mjs` does not trust shapes.
  assert.ok(view.streetPools.length > 0, 'the street recorded no pools at all')
  for (const name of view.streetPools) {
    assert.notEqual(view.pools[name], undefined, `${name} is named but was never created`)
    assert.equal(view.pools[name].mesh.count, view.pools[name].used, `${name} is named but never committed`)
  }
  assert.ok(view.pools.parapets.mesh.count > 0, 'the parapet pool committed zero instances')
})

check('the retired window and porchLight fixtures draw nothing (pass 5 review)', () => {
  // The pass-5 review's finding. `_addFacadeWindows` and `_addEntrance` are the
  // only things that should put glass or a light on a house wall, and this exists
  // because for the whole of pass 5 they were NOT: the legacy `window` and
  // `porchLight` fixture kinds were still emitted by `neighborhood.js` and still
  // placed, as 132 always-lit `windowLit` panels and 132 `sodium` porch lights.
  // (44 slots each, placed into all three `WRAP_COPIES`; the pre-review file's
  // `fixturePools.window.used` reports exactly 132.)
  //
  // The two claims that were false because of it are both about the RENDER rather
  // than the constants, which is why every other gate missed them: the ladder gate
  // reads `PALETTE` and the lit-rate gate counts `pools.windowLit`. So this gate
  // is stated in the only units that could have caught it — what the fixture pools
  // actually hold.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  for (const kind of ['window', 'porchLight']) {
    assert.equal(
      view.fixturePools[kind],
      undefined,
      `the ${kind} fixture pool exists again — it will draw ${view.fixturePools[kind]?.used ?? 0} ` +
        'emissive panels on top of the facade system, on a rung of the ladder the pass does not own',
    )
  }
  // ...and the negative form, which is the one that would catch a re-add: no
  // fixture pool may hold a material that is one of the two facade emissive
  // rungs. This is the check that has teeth if a THIRD retired kind is added
  // later and someone forgets to add it to the list above.
  for (const [kind, pool] of Object.entries(view.fixturePools)) {
    assert.notEqual(
      pool.mesh.material,
      view._materials.windowLit,
      `the ${kind} fixture draws on the windowLit rung — a lit window is the facade system's job`,
    )
    assert.notEqual(
      pool.mesh.material,
      view._materials.sodium,
      `the ${kind} fixture draws on the sodium rung, which is the lamp head, not a fitting`,
    )
  }
  // The world still has its windows and its entry lamps, so this cannot be
  // satisfied by deleting the facade system instead of retiring the old kinds.
  assert.ok(view.pools.windowLit.mesh.count > 0, 'the facade system placed no lit windows')
  assert.ok(view.pools.entryLamps.mesh.count > 0, 'the facade system placed no entry lamps')
})

/**
 * The instance translations of a pool, straight out of the matrix buffer.
 *
 * `InstancedMesh` stores one `Matrix4` per instance and a `Matrix4` is column
 * major, so the translation is elements 12-14 of every 16 — the same numbers
 * `place` wrote, read back without a `THREE.Matrix4` to decode them. This is the
 * only way the harness can ask where a piece of street furniture actually IS,
 * and it is the difference between a check that measures the world and one that
 * re-reads the code that built it.
 */
function instances(pool) {
  const array = pool.mesh.instanceMatrix.array
  const out = []
  for (let i = 0; i < pool.used; i += 1) {
    out.push({ x: array[i * 16 + 12], y: array[i * 16 + 13], z: array[i * 16 + 14] })
  }
  return out
}

check('the wires are ONE mesh carrying every span, and nothing else draws them', () => {
  // T8's cost claim, measured on the built scene: "Everything lands in one mesh,
  // frustumCulled = false, no outline pass." One mesh is the whole of it — a
  // `LineSegments` per span would be 252 draw calls at one pixel of width, which
  // is the shimmer the technique exists to remove.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const wire = view.wireMesh
  assert.ok(wire, 'the world has no wire mesh at all')
  let named = 0
  view.group.traverse((object) => {
    if (object.name === 'wires') named += 1
  })
  assert.equal(named, 1, `the wire system is ${named} meshes, and every extra one is a second draw call`)
  assert.equal(wire.parent, view.group, 'the wire mesh is not on the street group, so the wrap does not carry it')
  assert.equal(wire.frustumCulled, false, 'the wire is frustum-culled; its bounds are the whole world')
  assert.equal(wire.material, view._materials.wire)
  // ...and the geometry is the four-attribute ribbon, indexed, sized from the
  // span list rather than from a hard-coded count.
  const attributes = wire.geometry.attributes
  for (const name of ['position', 'aEnd', 'aSide', 'aWidth']) {
    assert.ok(attributes[name], `the wire geometry has no ${name} attribute`)
  }
  const spans = view.wireSpans
  assert.ok(spans.length > 0, 'the view reports no spans')
  // One entry in `wireSpans` is one CONDUCTOR, so a whole number of quads per
  // entry is the segment count — read back out of the geometry rather than
  // imported, because `streetView.js` is not a pure module and the gate cannot
  // call `makeWireGeometry` itself.
  const perConductor = wire.geometry.index.count / 6 / spans.length
  assert.equal(perConductor, 12, `a span is sampled every ${perConductor} m, which is not the twelve T7 asks for`)
  assert.equal(attributes.position.count, spans.length * perConductor * 4, 'the vertex count is not four corners per quad')
  assert.equal(attributes.aSide.count, attributes.position.count, 'the ribbon sides do not line up with its corners')
})

check('every wire quad is a fan of its OWN four corners, paired to the other end of its segment', () => {
  // THE REVIEW'S FINDING, and the reason this check exists. The check above
  // proves the wire HAS an `aEnd` attribute. It does not prove anything is IN
  // it, and the pass shipped both of these defects live:
  //
  //   1. `aEnd` was paired by reading the quad's corner order as an
  //      ALTERNATION (`k < 2 ? q : p`). The order is a RING — p, q, q, p — so
  //      k=1 (a `q` corner) was handed `q` and k=3 (a `p` corner) was handed
  //      `p`: a zero-length segment on 36,288 of the 72,576 corners. A
  //      zero-length segment has no direction, so the shader's `dir` falls back
  //      to a hardcoded `(1, 0)` and the ribbon is extruded along the screen's y
  //      axis rather than perpendicular to the wire.
  //   2. the index base was read off `face`, which counts INDICES at six per
  //      quad, instead of off `corner`, which counts VERTICES at four. The two
  //      drift apart by two per quad, so the first quad is coincidentally
  //      right and every later triangle spans three unrelated world positions.
  //
  // Both are read here off the BUILT buffer rather than off the source, because
  // the source carried a long, confident, CORRECT comment about each one while
  // the code was wrong — which is the only evidence available that a comment is
  // not a test. Neither defect is legible in a screenshot: each rasterises as
  // "a handful of screen-filling wedges", which is also what a healthy wire
  // looks like from the wrong angle.
  game.restart()
  run(game, 0.5)
  const wire = game.streetView.wireMesh
  assert.ok(wire, 'the world has no wire mesh at all')
  const { position, aEnd, aSide } = wire.geometry.attributes
  const index = wire.geometry.index.array
  const quads = index.length / 6

  let badIndex = 0
  let degenerateEnds = 0
  let stitchedSides = 0
  for (let q = 0; q < quads; q += 1) {
    const base = q * 4
    // 1. THE INDEX. Six indices per quad, all inside this quad's own four
    // corners, in the order the fan needs: base, base+1, base+2 | base, base+2,
    // base+3. Requiring the exact order and not merely membership is what
    // catches a base that has drifted by one; requiring membership at all is
    // what catches one that has drifted by two.
    const own = [base, base + 1, base + 2, base, base + 2, base + 3]
    for (let k = 0; k < 6; k += 1) {
      if (index[q * 6 + k] !== own[k]) badIndex += 1
    }
    // 2. THE PAIRING. `aEnd` is the OTHER sample of the same segment, so it is
    // never the corner's own position, and never a zero-length hop.
    for (let k = 0; k < 4; k += 1) {
      const at = (base + k) * 3
      if (
        aEnd.array[at] === position.array[at] &&
        aEnd.array[at + 1] === position.array[at + 1] &&
        aEnd.array[at + 2] === position.array[at + 2]
      ) {
        degenerateEnds += 1
      }
    }
    // 3. THE SIDES. `aSide` alone opens the ribbon, which is only true if the
    // two `p` corners share one side and the two `q` corners share the other.
    // A quad that ALTERNATES is a quad stitched to its neighbour's, and the
    // seam is invisible in the buffer — only the table gives it away.
    if (
      aSide.array[base] !== aSide.array[base + 1] ||
      aSide.array[base + 2] !== aSide.array[base + 3] ||
      aSide.array[base] === aSide.array[base + 2]
    ) {
      stitchedSides += 1
    }
  }
  assert.equal(badIndex, 0, `${badIndex} of ${quads * 6} wire indices are not this quad's own fan, so the buffer stitches triangles across quads`)
  assert.equal(degenerateEnds, 0, `${degenerateEnds} of ${quads * 4} wire corners carry their OWN position as aEnd, so the shader has no segment to expand along`)
  assert.equal(stitchedSides, 0, `${stitchedSides} wire quads alternate aSide, so the ribbon is stitched along the span instead of opened across it`)
})

check('the poles carry six conductors each, and stand on the pavement in all three copies', () => {
  // "Poles go at block corners, 8-10 m, with a crossarm and two insulators"
  // (AESTHETIC-NOTES §5) — read off the instance buffer rather than the source,
  // so a pool that was created and never filled cannot pass this.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const nodes = hood.GRID * hood.GRID
  assert.equal(view.pools.poleShafts.used, nodes * 3, 'not every intersection has a pole in every wrapped copy')
  // A pole is a shaft, two axes x (an arm, a bracket and a hook) and two axes x
  // six insulators. The insulators are what makes "six conductors" true: three
  // trunk on the arm, two secondary on the bracket, one telecom on the hook.
  assert.equal(view.pools.poleArms.used, nodes * 3 * 6, 'a pole does not carry an arm, a bracket and a hook on both axes')
  assert.equal(view.pools.poleInsulators.used, nodes * 3 * 12, 'a pole does not carry six insulators on both axes')
  // ...and every one of them stands `STREET_HALF_WIDTH + POLE_KERB_SETBACK` from
  // BOTH road axes, which is a pavement position and not a carriageway one. A
  // pole in the road is the one placement error this pass cannot have: it is
  // 9.2 m of geometry standing in the middle of the thing the player walks on.
  const poles = instances(view.pools.poleShafts)
  // The road axes of all THREE wrapped copies, because the poles are drawn in
  // all three and a check that folded only the canonical ones would measure a
  // pole 455 m from the nearest avenue and call it wrong.
  const axes = []
  for (const copy of [-1, 0, 1]) {
    for (let i = 0; i < hood.GRID; i += 1) axes.push(hood.roadAxisToWorld(i) + copy * hood.WORLD_EXTENT)
  }
  const standoff = hood.STREET_HALF_WIDTH + 1
  for (const pole of poles) {
    const fromX = Math.min(...axes.map((axis) => Math.abs(pole.x - axis)))
    const fromZ = Math.min(...axes.map((axis) => Math.abs(pole.z - axis)))
    assert.ok(Math.abs(fromX - standoff) < 1e-3, `a pole stands ${fromX.toFixed(2)} m from the nearest avenue, not ${standoff}`)
    assert.ok(Math.abs(fromZ - standoff) < 1e-3, `a pole stands ${fromZ.toFixed(2)} m from the nearest street, not ${standoff}`)
    // and it is on the PAVEMENT: past the kerb face, short of the lot line.
    assert.ok(fromX > hood.STREET_HALF_WIDTH + 0.4, 'a pole is standing in the carriageway')
    assert.ok(fromX < hood.STREET_HALF_WIDTH + 3.4, 'a pole is standing in somebody\'s garden')
  }
  // ...and all three wrapped copies really are drawn, which is the same seam
  // claim the lot builder makes and the same reason the wire does not cross it.
  const periods = new Set(poles.map((pole) => Math.round(pole.x / hood.WORLD_EXTENT)))
  assert.deepEqual([...periods].sort(), [-1, 0, 1], 'the poles are not drawn in all three wrapped copies')
})

check('the wires sag, the tiers are ordered, and one span in five hangs lower (T7)', () => {
  // "Our spans should not all sag the same amount: heavier trunk cables sag more
  // than telecom, and one span in five should be noticeably lower than its
  // neighbours." All three halves, measured per span rather than read from the
  // table the file also uses to build them.
  game.restart()
  run(game, 0.5)
  const spans = game.streetView.wireSpans
  const byTier = new Map()
  for (const span of spans) {
    const run = Math.hypot(span.b.x - span.a.x, span.b.z - span.a.z)
    assert.ok(run > 40 && run < 90, `a span is ${run.toFixed(1)} m long, which is neither a block edge nor a neighbour`)
    const ratio = span.sag / run
    const entry = byTier.get(span.tier) ?? { ratios: new Set(), widths: new Set(), y: new Set() }
    entry.ratios.add(Number(ratio.toFixed(4)))
    entry.widths.add(span.width)
    entry.y.add(span.a.y)
    byTier.set(span.tier, entry)
  }
  assert.equal(byTier.size, 3, `the wire system has ${byTier.size} tiers, not the three T7 names`)
  for (const [tier, entry] of byTier) {
    assert.equal(entry.widths.size, 1, `the ${tier} tier is more than one diameter`)
    // Two sags per tier and no more: the tier's own, and the 1-in-5 that is
    // 1.7x lower. A third value would be a fourth rule nobody wrote down.
    assert.equal(entry.ratios.size, 2, `the ${tier} tier has ${entry.ratios.size} sag ratios, and two is the whole of the rule`)
  }
  const [trunk, secondary, telecom] = ['trunk', 'secondary', 'telecom'].map((name) => byTier.get(name))
  const base = (entry) => Math.min(...entry.ratios)
  assert.ok(base(trunk) > base(secondary), 'the trunk circuit does not sag more than the secondary one')
  assert.ok(base(secondary) > base(telecom), 'the secondary circuit does not sag more than the telecom one')
  assert.ok(Math.max(...trunk.ratios) > base(trunk) * 1.5, 'no trunk span hangs lower than its neighbours')
  // The heights step DOWN the pole and the widths step DOWN with them, which is
  // what makes three parallel lines at 0.6 m spacing read as three circuits
  // rather than as one line with a shadow.
  assert.ok(Math.max(...trunk.y) > Math.max(...secondary.y), 'the trunk tier is not the highest circuit')
  assert.ok(Math.max(...secondary.y) > Math.max(...telecom.y), 'the telecom tier is not the lowest circuit')
  assert.ok(Math.max(...trunk.widths) > Math.max(...telecom.widths), 'the trunk circuit is not the thickest one')
  // ...and the low spans are the 1-in-5, measured on whole spans rather than on
  // conductors: six conductors of a low span are all low, so the share of SPANS
  // is the number the rule is about.
  const runs = new Map()
  for (const span of spans) {
    const key = `${span.a.x},${span.a.z}|${span.b.x},${span.b.z}`
    const run = Math.hypot(span.b.x - span.a.x, span.b.z - span.a.z)
    const ratio = span.sag / run
    runs.set(key, Math.max(runs.get(key) ?? 0, ratio / base(byTier.get(span.tier))))
  }
  const low = [...runs.values()].filter((ratio) => ratio > 1.5).length
  const share = low / runs.size
  assert.ok(share > 0.1 && share < 0.32, `${(share * 100).toFixed(0)}% of spans hang low, which is not "one span in five"`)
})

check('the wires clear the rooftops, the lamps and the player', () => {
  // A span is a parabola whose lowest point is the middle, and a wire that ends
  // up below a roofline or a lamp head is the one artefact in this pass that is
  // visible in a screenshot rather than in a number. The floor is the player's
  // head (1.8 m) with a wire's worth of daylight; the ceiling is the arm, since a
  // wire that rises above the thing it hangs from is a wire that does not sag.
  game.restart()
  run(game, 0.5)
  const spans = game.streetView.wireSpans
  let lowest = Infinity
  let highest = -Infinity
  for (const span of spans) {
    lowest = Math.min(lowest, span.a.y - span.sag)
    highest = Math.max(highest, span.a.y)
  }
  assert.ok(lowest > 4.5, `the lowest wire dips to ${lowest.toFixed(2)} m, which is over a player's head`)
  assert.ok(highest < 8.6, `the highest wire is at ${highest.toFixed(2)} m, which is above its own crossarm`)
  // ...and the top tier clears the tallest thing in the world on an ORDINARY
  // span. The tallest roof is a 5.2 m wall with a 0.34 m parapet, and a wire
  // that passed through it would be a wire through a building rather than over a
  // street. The low 1-in-5 spans are allowed closer — that is the rule working.
  const block = 64
  const ordinary = 8.51 - 0.024 * block
  assert.ok(ordinary > 5.54, `an ordinary trunk span dips to ${ordinary.toFixed(2)} m, into the rooflines`)
  assert.ok(lowest < ordinary, 'the low spans are not lower than the ordinary ones')
})

check('the gully is in the gutter, the hydrant is on the walk and the sign is on a corner', () => {
  // The three small things, placed against the same reservation the pole is, and
  // each in the place its kind actually goes: a gully is in the ROAD against the
  // kerb, a hydrant is on the PAVEMENT at the back of it, and a sign is at the
  // kerb corner facing the intersection.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const axes = []
  for (const copy of [-1, 0, 1]) {
    for (let i = 0; i < hood.GRID; i += 1) axes.push(hood.roadAxisToWorld(i) + copy * hood.WORLD_EXTENT)
  }
  const gutter = hood.STREET_HALF_WIDTH + 0.4 - 0.2
  const frames = instances(view.pools.drainFrames)
  assert.equal(frames.length, view.pools.drainBars.used / 5, 'a gully does not have five bars')
  for (const frame of frames) {
    const fromX = Math.min(...axes.map((axis) => Math.abs(frame.x - axis)))
    const fromZ = Math.min(...axes.map((axis) => Math.abs(frame.z - axis)))
    const onX = Math.abs(fromX - gutter) < 1e-3
    const onZ = Math.abs(fromZ - gutter) < 1e-3
    assert.ok(onX !== onZ, `a gully is ${fromX.toFixed(2)}/${fromZ.toFixed(2)} m from the road axes, so it is in neither gutter`)
    // the other axis is 2.5 m along the kerb, out of the corner
    assert.ok(Math.abs((onX ? fromZ : fromX) - 2.5) < 1e-3, 'a gully is sitting in the corner instead of at the low point')
    assert.ok(frame.y < 0.02, `a gully rim is ${frame.y.toFixed(3)} m up, which is a biscuit tin on the tarmac`)
  }
  // ...and both rates are the ones the constants claim, read off the built scene:
  // a gully on about half the intersections and a hydrant on about a third, and
  // NOT the same set of corners, which is the point of running them at
  // different rates.
  const opportunities = hood.GRID * hood.GRID * 3
  const hydrantRate = view.pools.hydrants.used / 4 / opportunities
  const drainRate = frames.length / opportunities
  assert.ok(hydrantRate > 0.2 && hydrantRate < 0.45, `${(hydrantRate * 100).toFixed(0)}% of corners have a hydrant, which is not one in three`)
  assert.ok(drainRate > 0.35 && drainRate < 0.65, `${(drainRate * 100).toFixed(0)}% of corners have a gully, which is not one in two`)
  // The hydrant is knee height on the pavement: a barrel, a bonnet and two caps
  // per fixture, and nothing above 0.9 m.
  const hydrants = instances(view.pools.hydrants)
  assert.equal(hydrants.length % 4, 0, 'a hydrant is not four pieces')
  for (const piece of hydrants) {
    assert.ok(piece.y > 0 && piece.y < 0.9, `a hydrant piece is at ${piece.y.toFixed(2)} m`)
    const fromX = Math.min(...axes.map((axis) => Math.abs(piece.x - axis)))
    assert.ok(fromX > hood.STREET_HALF_WIDTH + 0.4, 'a hydrant is standing in the road')
  }
  // ...and a sign is a 2.55 m post with its face at 2.05 m, which is where a
  // driver reads it and above where a pedestrian looks.
  const plates = instances(view.pools.signPlates)
  assert.equal(plates.length, hood.GRID * hood.GRID * 2 * 3, 'every intersection does not carry exactly two signs')
  for (const plate of plates) {
    assert.ok(plate.y > 1.9 && plate.y < 2.3, `a sign face is at ${plate.y.toFixed(2)} m, which is neither car nor pedestrian height`)
  }
})

check('the wire shader is told the DEVICE resolution, and follows a resize', () => {
  // T8 computes its width in pixels, so the resolution is a uniform and a
  // uniform nobody updates is a wire at the wrong width in a resized window. The
  // buffer is not the element: `world.js` caps the pixel ratio at 1.5.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const uniform = view._materials.wire.uniforms.uResolution.value
  assert.equal(uniform.x, view.resolution.x)
  assert.equal(uniform.y, view.resolution.y)
  const ratio = game.pixelRatio
  assert.ok(ratio > 0 && ratio <= 1.5, `the pixel ratio is ${ratio}, which is not the capped one world.js promises`)
  // the resolution is the DEVICE one, so it is the element multiplied
  const expected = Math.round((game.container.clientWidth || 800) * ratio)
  assert.equal(uniform.x, expected, `the wire is sized for ${uniform.x} px, and the buffer is ${expected} px`)
  view.setResolution(1600, 900)
  assert.equal(uniform.x, 1600, 'setResolution did not reach the shader')
  assert.equal(uniform.y, 900)
  // ...and a live resize takes the same path, so the two can never disagree.
  game.resize()
  assert.equal(uniform.x, game._bufferSize().x, 'a resize did not tell the wire how big the buffer is')
  assert.equal(uniform.y, game._bufferSize().y)
})

// ===========================================================================
// STREET FURNITURE II (iteration 2, pass 7)
//
// Six claims, all of them about the BUILT scene, because every one of them is a
// claim a comment in the source would satisfy:
//
//   1. the fifteen pools are placed, and every object is the number of pieces it
//      claims (a machine with no liner passes a `> 0` test and fails this)
//   2. the rate table is real — three kinds are MISSING from a whole quadrant — and
//      the districts' compass names are DERIVED from the built lots, not read out
//      of the comment that got two of them wrong
//   3. nothing stands in a carriageway and nothing stands within 12 m of a portal.
//      This is the structural form of the pass-3 pupil gate (luma <= 20, measured in
//      `portal-located.png` from 4.5 m) and of the pass-6 creature gate (a 9x7 eye
//      in `creature-stalking.png`): a 2.30 m shelter in the stand-off does not merely
//      look wrong, it changes the number the iteration is measured against.
//      `creatureView.js` is untouched and `verify.mjs` still asserts EYE_RENDER_ORDER.
//   4. the lit liner is a fogged SURFACE rather than an unfogged glow, and exactly
//      ONE machine in the world misbehaves
//   5. the flicker is a pure function of the clock, stepped, floored, and written to
//      the bad machine's material only
//   6. a bin stands on its castors, a bike's wheels touch the ground, and a poster
//      is an alpha-tested 0.42 x 0.60 decal
// ===========================================================================

/**
 * The rate table, read out of the source.
 *
 * From the file rather than typed here, so the check and the thing it checks cannot
 * disagree about what the rates are — the same reason `verify.mjs` reads
 * `LOT_PART_BUDGET` from `streetView.js` instead of repeating 40. It is a table in a
 * comment-free `Object.freeze` call, so a regex is a complete parse of it.
 */
const STREET_VIEW_SOURCE = readFileSync(new URL('./src/game/streetView.js', import.meta.url), 'utf8')
// Iteration 2, pass 9. Read for `skyNumber` above, and only for it: the horizon
// ring's radius is a claim about a constant and a build, and the two cannot both
// be read off the scene.
const SKY_VIEW_SOURCE = readFileSync(new URL('./src/game/skyView.js', import.meta.url), 'utf8')

/** The fifteen pools this pass adds, in creation order. */
const PASS7_POOLS = Object.freeze([
  'dumpsters', 'trashBags', 'vendingBodies', 'vendingFaces', 'vendingLitFaces',
  'vendingFlickerFaces', 'vendingRails', 'shelterSteel', 'shelterBenches',
  'shelterAds', 'bollards', 'bikeFrames', 'bikeWheels', 'posters', 'postersTorn',
])

/** The five pools iteration 2 pass 8 adds, in creation order. */
const PASS8_POOLS = Object.freeze(['wetSheen', 'puddles', 'streaks', 'canalLips', 'canalWater'])

/** The families that stand on the PAVEMENT, and so are measured against the road. */
const PASS7_PAVEMENT_POOLS = Object.freeze([
  'vendingBodies', 'vendingFaces', 'vendingLitFaces', 'vendingFlickerFaces',
  'vendingRails', 'bollards', 'shelterSteel', 'shelterBenches', 'shelterAds',
  'bikeFrames', 'bikeWheels',
])

/**
 * `canonicalXZ` — fold a drawn coordinate back to the canonical copy.
 *
 * `neighborhood.js`'s own `canonicalCoord`, and the reason this is not three lines of
 * `round` is that the first version of this fold was wrong in a way that invented a
 * bug. The world's canonical window is NOT [-224, +224]: `CANONICAL_ORIGIN` puts it at
 * [32 - 224, 32 + 224], and the drawn world runs from -184 to +248. A machine placed
 * at canonical x = 248.1 is drawn at -199.9 in copy -1, and a symmetric fold left it
 * at -199.9 — inside the naive window, 16 m outside the real one, and 448 m from the
 * lot that owns it. The check then reported a machine in a carriageway that does not
 * exist. `originFor` is the one definition of "which copy is this" in this
 * repository and this defers to it, which is also why `creature.js` uses it.
 *
 * Every spatial check below folds FIRST: a check that measured copy -1 against a
 * canonical portal would see a whole period of nothing and pass everything.
 */
function canonicalXZ(x, z) {
  return { x: hood.canonicalCoord(x), z: hood.canonicalCoord(z) }
}

/** Every road centreline in the world. */
function roadAxes() {
  const axes = []
  for (let i = 0; i < hood.GRID; i += 1) axes.push(hood.canonicalCoord(hood.roadAxisToWorld(i)))
  return axes
}

/** Every lot of the world, canonical, with the district its chunk is in. */
function lotTable(view) {
  const table = []
  for (let cx = 0; cx < hood.GRID; cx += 1) {
    for (let cz = 0; cz < hood.GRID; cz += 1) {
      for (const lot of hood.chunkAt(view.seed, cx, cz).lots) {
        const at = canonicalXZ(lot.x, lot.z)
        table.push({ x: at.x, z: at.z, side: lot.side, w: lot.w, d: lot.d, district: hood.districtOf(cx, cz) })
      }
    }
  }
  return table
}

/** Every intersection, canonical, with the district `districtOf` gives it. */
function nodeTable() {
  const nodes = []
  for (let ax = 0; ax < hood.GRID; ax += 1) {
    for (let az = 0; az < hood.GRID; az += 1) {
      const node = hood.streetNodeToWorld(hood.streetNodeId(ax, az))
      const at = canonicalXZ(node.x, node.z)
      nodes.push({ x: at.x, z: at.z, district: hood.districtOf(ax, az) })
    }
  }
  return nodes
}

/** The nearest node to a point — the owner of a shelter or a bicycle. */
function nearestNode(nodes, x, z) {
  return nodes.reduce((best, node) => (
    Math.hypot(node.x - x, node.z - z) < best.d ? { d: Math.hypot(node.x - x, node.z - z), node } : best
  ), { d: Infinity, node: null }).node
}

/**
 * The per-instance SCALE out of a matrix buffer, which is where a size claim lives.
 *
 * COLUMN NORMS and not the raw elements, which is the whole of it: `place` composes
 * a yaw, so element 0 of a yawed instance is `scaleX * cos(yaw)` and element 5 is
 * `scaleY`. Reading the elements directly reported a lid as SMALLER than the body it
 * overhangs for every lot on the south side of an avenue — a size check that is wrong
 * for exactly half the world, and wrong in the direction that makes a defect look
 * like a pass.
 */
function scales(pool) {
  const array = pool.mesh.instanceMatrix.array
  const out = []
  for (let i = 0; i < pool.used; i += 1) out.push({ ...frameScale(array, i), ...frameOffset(array, i) })
  return out
}

/** The scale of one instance: the length of each basis column. */
function frameScale(array, i) {
  const at = (k) => array[i * 16 + k]
  const norm = (a, b, c) => Math.hypot(at(a), at(b), at(c))
  return { sx: norm(0, 1, 2), sy: norm(4, 5, 6), sz: norm(8, 9, 10) }
}

/** The translation of one instance. */
function frameOffset(array, i) {
  return { x: array[i * 16 + 12], y: array[i * 16 + 13], z: array[i * 16 + 14] }
}

check('every pass-7 family is placed, and every object is the pieces it claims', () => {
  // T5's rule applied to fifteen pools at once, and the assertions are ARITHMETIC
  // identities between pools rather than "more than zero". A machine with no liner, a
  // shelter with no ad panel and a bike with three wheels all pass a `> 0` test.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  for (const name of PASS7_POOLS) {
    assert.ok(view.pools[name], `the pass-7 pool ${name} does not exist, so this pass is not in the build`)
    assert.ok(view.pools[name].used > 0, `${name} placed nothing at all, so its rate is not a rate`)
    assert.equal(view.pools[name].overflow, 0, `${name} overflowed and dropped ${view.pools[name].overflow} instances`)
  }
  // A machine is a body, ONE liner and two rails, and the liner is in exactly one of
  // the three liner pools — so the three liners sum to the bodies.
  const bodies = view.pools.vendingBodies.used
  assert.equal(
    view.pools.vendingFaces.used + view.pools.vendingLitFaces.used + view.pools.vendingFlickerFaces.used,
    bodies,
    'a machine has no liner, or two of them',
  )
  assert.equal(view.pools.vendingRails.used, bodies * 2, 'a machine does not have two product rails')
  // A shelter is a back, two posts and a roof — four — plus a bench and an ad panel.
  const shelters = view.pools.shelterAds.used
  assert.equal(view.pools.shelterSteel.used, shelters * 4, 'a shelter is not a back, two posts and a roof')
  assert.equal(view.pools.shelterBenches.used, shelters, 'a shelter with no bench is a bus stop sign')
  // A bike is five frame bars and two wheels; a bin is four pieces; a bag is two.
  assert.equal(view.pools.bikeWheels.used % 2, 0, 'a bike has an odd number of wheels')
  assert.equal(view.pools.bikeFrames.used, (view.pools.bikeWheels.used / 2) * 5, 'a bike is not five bars and two wheels')
  assert.equal(view.pools.dumpsters.used % 4, 0, 'a bin is not two castors, a body and a lid')
  assert.equal(view.pools.trashBags.used % 2, 0, 'a bag is not a lump and a knot')
  assert.equal(view.pools.bollards.used % 4, 0, 'a bollard run is not two posts of two pieces')
  // Both poster pools are used: "a torn sheet" as a claim with no torn sheet in the
  // world is a claim about a texture nobody ever sees.
  assert.ok(view.pools.postersTorn.used > 0, 'no torn poster exists, so the tear is a texture and not a feature')
  const tornShare = view.pools.postersTorn.used / (view.pools.posters.used + view.pools.postersTorn.used)
  assert.ok(tornShare > 0.2 && tornShare < 0.5, `${(tornShare * 100).toFixed(0)}% of the posters are torn, which is not one in three`)
  // ...and the pass costs exactly fifteen draw calls on top of the thirty already there.
  // The count is `30 + pass 7 + pass 8` rather than `30 + pass 7`, and that is a
  // correction to a gate that was correct when written and wrong the moment a
  // later pass added a pool: a hard-coded 45 means every future pass that draws
  // anything fails a check whose subject is pass 7's draw-call budget, and the
  // tempting repair — deleting the assertion — is how the budget stops being
  // checked at all. Each pass's pools are named in `PASS7_POOLS`/`PASS8_POOLS`
  // and the total is their sum, so a pass that adds a pool must add it to a list
  // that a reviewer can read.
  assert.equal(
    view.streetPools.length,
    30 + PASS7_POOLS.length + PASS8_POOLS.length,
    'the two passes added a different number of pools than they claim',
  )
  for (const name of PASS8_POOLS) {
    assert.ok(view.pools[name], `the pass-8 pool ${name} does not exist, so this pass is not in the build`)
    assert.ok(view.pools[name].used > 0, `${name} placed nothing at all, so its rate is not a rate`)
    assert.equal(view.pools[name].overflow, 0, `${name} overflowed and dropped ${view.pools[name].overflow} instances`)
  }
})

check('the district table is real: three kinds are missing from a whole quadrant', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const log = view.dressingLog
  assert.ok(log.length > 0, 'the world published no dressing log, so the rate table cannot be read back')
  // The four districts, and the compass names DERIVED from the built lots rather than
  // read out of the comment. The first draft of `DISTRICT_DRESSING` called districts 1
  // and 2 the wrong way round and nothing in the source could have caught it: the
  // rates are a table, the names are a comment.
  const lots = lotTable(view)
  const quadrant = [0, 1, 2, 3].map(() => ({ x: [], z: [] }))
  for (const lot of lots) {
    quadrant[lot.district].x.push(lot.x)
    quadrant[lot.district].z.push(lot.z)
  }
  const centre = (values) => values.reduce((a, b) => a + b, 0) / values.length
  const byX = quadrant.map((q) => centre(q.x))
  const byZ = quadrant.map((q) => centre(q.z))
  const xEdge = (Math.min(...byX) + Math.max(...byX)) / 2
  const zEdge = (Math.min(...byZ) + Math.max(...byZ)) / 2
  const compass = quadrant.map((q, d) => `${byX[d] < xEdge ? 'W' : 'E'}${byZ[d] < zEdge ? 'N' : 'S'}`)
  assert.equal(new Set(compass).size, 4, `the four districts are ${compass.join(', ')}, which is not four different quadrants`)
  // The rates, read out of the source table rather than hard-coded here, so this
  // check and the file under test cannot disagree about what the rates are.
  const table = [...STREET_VIEW_SOURCE.matchAll(/Object\.freeze\(\{ dumpster: (\d+), bags: (\d+), poster: (\d+), vending: (\d+), shelter: (\d+), bollard: (\d+), bike: (\d+) \}\)/g)]
    .map(([, dumpster, bags, poster, vending, shelter, bollard, bike]) => ({
      dumpster: +dumpster, bags: +bags, poster: +poster, vending: +vending, shelter: +shelter, bollard: +bollard, bike: +bike,
    }))
  assert.equal(table.length, 4, 'the district rate table is not four rows any more')
  // The claim: a rate of zero places NOTHING, in the whole quadrant. `dressingLog`
  // carries the district each object was addressed to, which is the same value the
  // rate lookup read — so this fails the moment a placement stops consulting the table.
  for (let d = 0; d < 4; d += 1) {
    for (const kind of ['vending', 'shelter', 'bike', 'dumpster', 'poster', 'bollard']) {
      const placed = log.filter((entry) => entry.kind === kind && entry.district === d).length
      if (table[d][kind] === 0) {
        assert.equal(placed, 0, `district ${d} (${compass[d]}) has ${placed} ${kind} objects and its rate is zero`)
      }
    }
  }
  // A non-zero rate is NOT asserted to place something in EVERY district, because that
  // is a claim about sample size and not about the code: the south-east is nine
  // intersections and a bicycle rate of six, and on this seed it places none — a
  // (5/6)^9 chance, which is a legitimate outcome of a small draw rather than a defect.
  // The strong direction is the one above; this one is only that every family with a
  // rate somewhere exists in the world at all.
  for (const kind of ['vending', 'shelter', 'bike', 'dumpster', 'poster', 'bollard']) {
    const total = log.filter((entry) => entry.kind === kind).length
    assert.ok(table.some((row) => row[kind] > 0), `the rate table has no ${kind} rate anywhere, so the family is dead code`)
    assert.ok(total > 0, `the ${kind} family is placed nowhere in the world`)
  }
  // ...and the four districts are genuinely DIFFERENT, which is the whole point of
  // "per district rules". Four identical rows would pass every test above.
  const machines = [0, 1, 2, 3].map((d) => log.filter((entry) => entry.kind === 'vending' && entry.district === d).length)
  assert.ok(new Set(machines).size >= 3, `the machine counts are ${machines.join('/')}, which is not four different mixes`)
  const posters = [0, 1, 2, 3].map((d) => log.filter((entry) => entry.kind === 'poster' && entry.district === d).length)
  assert.ok(new Set(posters).size >= 3, `the poster counts are ${posters.join('/')}, which is not four different mixes`)
  // ...and the log agrees with the geometry, which is what makes it evidence rather
  // than a second opinion: every logged object has an instance, at the SAME drawn
  // position, in the pool it names. No fold is involved, and that is deliberate — the
  // log is written in the drawn frame (it comes from `inLot`, which has already added
  // `copy * WORLD_EXTENT`) and folding it with the check's own convention would move
  // every entry by a third of a period. The comparison is exact, to a millimetre.
  // A shelter is logged at its CENTRE, which is where its roof sits — the ad panel is
  // half a shelter's depth away on the back wall, so `shelterAds` is the wrong pool to
  // look in and the wrong one to have found this.
  const poolOf = { bag: 'trashBags', vending: 'vendingBodies', shelter: 'shelterSteel', bike: 'bikeFrames', dumpster: 'dumpsters', poster: 'posters', posterTorn: 'postersTorn', bollard: 'bollards' }
  // A MILLIMETRE of tolerance, and that is not slack: the matrix buffer is a
  // `Float32Array`, so an instance's position is the double the placement computed
  // rounded to 24 bits of mantissa — about 0.06 mm at 600 m. The first version of
  // this compared `toFixed(3)` strings, which is the same tolerance with a
  // knife-edge: a value 0.0001 mm from a millimetre boundary lands on both sides of
  // it, and one entry in a thousand then "has no instance there".
  const drawnAt = {}
  for (const name of Object.values(poolOf)) drawnAt[name] = instances(view.pools[name]).map((piece) => ({ x: piece.x, z: piece.z }))
  for (const entry of log) {
    const pool = poolOf[entry.kind]
    const found = drawnAt[pool].some((piece) => Math.abs(piece.x - entry.x) < 1e-3 && Math.abs(piece.z - entry.z) < 1e-3)
    assert.ok(found, `the log says a ${entry.kind} is at ${entry.x.toFixed(2)},${entry.z.toFixed(2)} and ${pool} has no instance there`)
  }
})

check('nothing stands in a carriageway, and nothing stands in front of a portal', () => {
  // The REGRESSION GUARD this pass owes passes 3 and 6, and it is spatial rather than
  // visual because both of those gates are measurements OF AN IMAGE. The pass-3 pupil
  // luma (<= 20) is read out of `portal-located.png` from 4.5 m out; the creature gate
  // anchors on a 9x7 eye. A 2.30 m shelter in the stand-off does not merely look wrong,
  // it changes the number the iteration is measured against.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const axes = roadAxes()
  const kerbFace = hood.STREET_HALF_WIDTH + 0.4
  let nearest = Infinity
  for (const name of PASS7_PAVEMENT_POOLS) {
    for (const piece of instances(view.pools[name])) {
      const at = canonicalXZ(piece.x, piece.z)
      nearest = Math.min(nearest, ...axes.map((axis) => Math.abs(at.x - axis)), ...axes.map((axis) => Math.abs(at.z - axis)))
    }
  }
  // 6.0 is the carriageway and 6.4 the kerb face between the two; the fixture measures
  // 6.49 on this seed, which is the shelter's front post standing on the kerb.
  assert.ok(nearest >= kerbFace, `a pass-7 object is ${nearest.toFixed(2)} m from a road centreline, inside the ${kerbFace} m kerb face`)
  // ...and the portal exclusion, read off the same buffers and compared against the
  // anchors rather than against the constant.
  let portalNearest = Infinity
  for (const name of PASS7_POOLS) {
    for (const piece of instances(view.pools[name])) {
      const at = canonicalXZ(piece.x, piece.z)
      for (const anchor of view.objectives.portals) {
        const gate = canonicalXZ(anchor.position.x, anchor.position.z)
        portalNearest = Math.min(portalNearest, Math.hypot(at.x - gate.x, at.z - gate.z))
      }
    }
  }
  assert.ok(portalNearest >= 12, `a pass-7 object is ${portalNearest.toFixed(2)} m from a portal, inside the 12 m stand-off`)
  // The exclusion is a FILTER and it FIRED — a rule that never rejects anything is
  // indistinguishable from a rule that is not implemented, and this is the residual
  // risk the pass-6 review left behind.
  assert.ok(view.dressingRejected > 0, 'the portal exclusion rejected nothing, so it is not being applied')
})

check('the lit liner is a fogged SURFACE, and exactly one machine misbehaves', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const materials = view._materials
  // `_glow` is `MeshBasicMaterial` with `fog: false`, and that is right for a lamp
  // head and a portal rim — both are SOURCES seen against the sky. It is wrong for a
  // panel 40 m down a street: an unfogged emissive punches a hole in the amber haze
  // and is visible from the far end of an avenue, which is the creature's corridor.
  // The assertion is on the MATERIAL, not on a comment about it.
  for (const name of ['vendingFaceLit', 'vendingFaceFlicker']) {
    const material = materials[name]
    assert.ok(material.isMeshStandardMaterial, `${name} is not a standard material, so it is either unfogged or unlit`)
    assert.notEqual(material.fog, false, `${name} has fog off, so a lit machine punches through the haze`)
    assert.equal(material.emissive.getHex(), 0xc9b79a, `${name} emits the wrong colour`)
  }
  assert.notEqual(materials.vendingFaceLit, materials.vendingFaceFlicker, 'the flickering liner SHARES the lit material, so every machine in the district gutters together')
  // The dim half of the pass: a machine with no tube, a backlit ad panel, and a sheet
  // of paper. None of the three may emit, and the ad panel is what the checklist
  // asked for by name.
  assert.equal(materials.vendingFaceDead.emissive.getHex(), 0x000000, 'a dead machine is emitting light')
  assert.equal(materials.adPanel.emissive.getHex(), 0x000000, 'the ad panel is emissive, which is a fifth rung on T11 for a rectangle nobody reads')
  assert.equal(materials.poster.emissive.getHex(), 0x000000, 'a paper poster is emitting light')
  // EXACTLY ONE, one per wrapped copy, and the world can say which lot owns it.
  assert.equal(view.pools.vendingFlickerFaces.used, 3, 'the world does not have exactly one flickering machine in each of its three copies')
  assert.ok(view.flickerLot, 'no lot owns the flickering machine')
  assert.match(view.flickerLot, /^\d+,\d+,[NSEW]$/, 'the flickering lot is not a cx,cz,side key')
  // ...and the lit machines are kept APART, which is the measurable half of D6's
  // "a frame does not hold two of them". 16.8 m on the default seed.
  // Folded, then DEDUPED: all three copies of a machine fold to the same canonical
  // point, so without the dedupe every lit machine is its own nearest neighbour at a
  // distance of exactly zero. (The first version of this filtered on
  // `|x| <= WORLD_EXTENT / 2` instead, which is a different window again and kept all
  // three copies — and reported a 0.00 m separation between two machines 16.8 m
  // apart.)
  const seen = new Set()
  const lit = []
  for (const piece of instances(view.pools.vendingLitFaces)) {
    const at = canonicalXZ(piece.x, piece.z)
    const key = `${at.x.toFixed(3)},${at.z.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    lit.push(at)
  }
  let nearestPair = Infinity
  for (let i = 0; i < lit.length; i += 1) {
    for (let j = i + 1; j < lit.length; j += 1) {
      nearestPair = Math.min(nearestPair, Math.hypot(lit[i].x - lit[j].x, lit[i].z - lit[j].z))
    }
  }
  assert.ok(nearestPair >= 12, `two lit machines are ${nearestPair.toFixed(1)} m apart, close enough to read as one bright thing`)
})

check('the flicker is a function of the clock, stepped, floored, and the bad machine only', () => {
  // The honest test for a seeded flicker is not "it changes" — a sum of sines changes
  // too. It is that the SAME time gives the SAME value, that the values are quantised,
  // that the floor is a floor, and that a GOOD machine is never written to at all.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const steady = view._materials.vendingFaceLit.emissiveIntensity
  view._time = 0
  view.update(0.5)
  const first = view._materials.vendingFaceFlicker.emissiveIntensity
  // A second of clock later, and then BACK to the same half second. The first version
  // of this check compared two consecutive `update` calls and called the difference a
  // broken clock; it was a check that forgot the clock had moved.
  view.update(0.5)
  const later = view._materials.vendingFaceFlicker.emissiveIntensity
  view._time = 0
  view.update(0.5)
  const again = view._materials.vendingFaceFlicker.emissiveIntensity
  assert.equal(first, again, 'driving the world back to the same time did not give the same level, so the flicker is not a function of the clock')
  const distinct = new Set(Array.from({ length: 40 }, (_, i) => {
    view._time = i / 11
    view.update(0)
    return view._materials.vendingFaceFlicker.emissiveIntensity
  })).size
  assert.ok(distinct > 10, `forty consecutive ticks produced ${distinct} levels, which is not a stepped flicker`)
  assert.ok(Number.isFinite(later), 'the level is not a number')
  // A STEP, not a breath: 200 ticks at 11 Hz, about 25 dropouts, and a lot of
  // distinct levels.
  const levels = new Set()
  let dropouts = 0
  for (let tick = 0; tick < 200; tick += 1) {
    view._time = tick / 11
    view.update(0)
    const level = view._materials.vendingFaceFlicker.emissiveIntensity
    levels.add(level)
    if (level <= 1.25 * 0.31) dropouts += 1
  }
  assert.ok(levels.size > 20, `200 ticks produced ${levels.size} distinct levels, which is not a hashed ball`)
  assert.ok(dropouts > 5 && dropouts < 45, `${dropouts} dropouts in 200 ticks, which is not about one in eight`)
  assert.ok(Math.min(...levels) > 0, 'the machine went fully dark, which is a dead machine rather than a failing one')
  assert.ok(Math.max(...levels) <= 1.25, 'the machine is brighter than its own emissive rung')
  assert.equal(view._materials.vendingFaceLit.emissiveIntensity, steady, 'a good machine changed brightness, so the pass has a second flicker')
})

check('a bin stands on its castors, a bike stands on its wheels, a poster is a decal', () => {
  // The reference's own failure list names floating and sunken objects as the defect
  // a viewer finds instantly and cannot name, so the families that touch the ground
  // are measured against it rather than photographed.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const parts = instances(view.pools.dumpsters)
  const size = scales(view.pools.dumpsters)
  for (let bin = 0; bin < parts.length / 4; bin += 1) {
    const group = parts.slice(bin * 4, bin * 4 + 4)
    const castors = group.filter((piece) => piece.y < 0.07)
    assert.equal(castors.length, 2, `a bin has ${castors.length} castors, so its body starts at y = 0 with no contact patch`)
    const body = size[bin * 4 + 2]
    const lid = size[bin * 4 + 3]
    assert.ok(lid.sx > body.sx && lid.sz > body.sz, 'the lid is not proud of the body, so a bin is a box')
    assert.ok(lid.sy < body.sy, 'the lid is as thick as the body it caps')
  }
  for (const piece of instances(view.pools.bikeWheels)) {
    assert.ok(Math.abs(piece.y - 0.335) < 1e-3, `a bicycle wheel is ${piece.y.toFixed(3)} m up, so the bike is floating or sunk`)
  }
  // The poster: A2, 10 mm thick, alpha-TESTED rather than blended — a blended torn
  // sheet is a second transparent surface to sort against the wall behind it, and a
  // depth-sorted edge that shimmers as the camera moves.
  const materials = view._materials
  for (const name of ['poster', 'posterTorn']) {
    assert.ok(materials[name].alphaTest > 0, `${name} is not alpha-tested, so its tear is a blend`)
    assert.notEqual(materials[name].transparent, true, `${name} is transparent, which sorts against the wall`)
    assert.ok(materials[name].map, `${name} has no print on it, so it is a beige rectangle`)
  }
  assert.notEqual(materials.poster.map, materials.posterTorn.map, 'the whole and torn posters share one texture, so the tear is the same sheet')
  for (const name of ['posters', 'postersTorn']) {
    const sheets = scales(view.pools[name])
    assert.ok(sheets.length > 0, `${name} placed nothing`)
    for (const sheet of sheets) {
      assert.ok(Math.abs(sheet.sy - 0.6) < 1e-6, `a poster is ${sheet.sy.toFixed(3)} m tall, which is not A2's short side`)
      const short = Math.min(sheet.sx, sheet.sz)
      const long = Math.max(sheet.sx, sheet.sz)
      assert.ok(Math.abs(short - 0.01) < 1e-6, 'a poster has no thickness, so a gate reading depth out of this buffer has nothing to read')
      assert.ok(Math.abs(long - 0.42) < 1e-6, `a poster is ${long.toFixed(3)} m on its long side, which is not A2's 0.42`)
    }
  }
  // ...and they are all at chest height, which is where a fly-poster goes and where a
  // player walking past reads one.
  const heights = new Set(instances(view.pools.posters).map((piece) => piece.y.toFixed(3)))
  assert.equal(heights.size, 1, `the posters are at ${[...heights].join(', ')} m`)
})

// ---------------------------------------------------------------------------
// PASS 7, REVIEW — the sightline. The rendered-visibility gate, and its own gate.
// ---------------------------------------------------------------------------

/**
 * `sightlineAt` — the same measurement `capture/main.jsx` makes, reimplemented
 * here in the one place that can be checked against a camera it chose itself.
 *
 * WHY IT IS REIMPLEMENTED RATHER THAN IMPORTED
 * -------------------------------------------
 * Because the probe cannot be imported: it is a closure over the capture page's
 * module-level `game`, it runs in a browser, and its input is a camera that only
 * exists after a real capture run. That makes it exactly the kind of component
 * this review exists to distrust — a function nothing in `node` can execute, on a
 * path that decides whether fourteen PNGs are acceptable, with no test that can
 * fail if it is wrong. So the arithmetic is restated here against a camera this
 * harness builds and aims, and the check below holds it to being able to report
 * a non-zero answer.
 *
 * The duplication is deliberate and it is the only defensible kind: both copies
 * take the near/far planes and the FOV off the camera itself rather than restating
 * them, and the check below fails a probe that reports "nothing" for a piece
 * planted directly in front of the lens.
 */
function sightlineAt(camera, pieces3d, unitRadius, minPx) {
  const focal = camera.height / 2 / Math.tan((camera.fov * Math.PI) / 360)
  const viewPoint = new THREE.Vector4()
  const clip = new THREE.Vector4()
  let onScreen = 0
  let legible = 0
  let nearest = Infinity
  for (const at of pieces3d) {
    // `Vector4`, or the w is gone and every piece in front of the lens gets
    // rejected as being behind it. Stated in the code because it is the single
    // line that turns this function into a no-op reporting an empty street.
    viewPoint.set(at.x, at.y, at.z, 1).applyMatrix4(camera.matrixWorldInverse)
    const depth = -viewPoint.z
    if (!(depth > camera.near) || depth > camera.far) continue
    clip.copy(viewPoint).applyMatrix4(camera.projectionMatrix)
    if (!(clip.w > 0)) continue
    const ndcX = clip.x / clip.w
    const ndcY = clip.y / clip.w
    if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) continue
    onScreen += 1
    if (depth < nearest) nearest = depth
    if ((unitRadius * focal) / depth >= minPx) legible += 1
  }
  return { onScreen, legible, nearest: Number.isFinite(nearest) ? nearest : null }
}

check('the furniture probe sees a piece planted in front of the lens, and nothing else', () => {
  // The mutation test for the gate that gates the gallery. A visibility probe is
  // only worth having if it can report a non-zero result, and the first version of
  // this one could not: it used `Vector3.applyMatrix4`, which divides by w and
  // throws it away, so `clip.w` was `undefined` after every projection, `w > 0`
  // was false everywhere, and all fourteen views reported "0 pieces in frame".
  //
  // That failure is unusually dangerous because it looks EXACTLY like the defect
  // it was written to find. It reported a street with no dumpster on it, which is
  // the pass's own claim, and for a real reason: pass 7 had put nothing legible
  // inside the frustum of the `street` stand-off. So nothing about the output was
  // anomalous. Only a test that aims a camera at a piece it placed itself can
  // tell a working probe from a broken one.
  const camera = new THREE.PerspectiveCamera(72, 1280 / 720, 0.05, 260)
  camera.height = 720
  camera.position.set(0, 1.75, 0)
  camera.rotation.set(0, 0, 0) // down -Z, which is three.js's forward
  camera.updateMatrixWorld(true)
  const unit = 0.5
  const minPx = 3
  const at = (x, y, z) => [{ x, y, z }]

  // Dead ahead, 5 m: the positive control. Without this the rest of the check
  // passes for a probe that reports nothing at all, which is the whole bug.
  const ahead = sightlineAt(camera, at(0, 1.75, -5), unit, minPx)
  assert.equal(ahead.onScreen, 1, 'a piece 5 m in front of the lens is not in frame, so the probe is blind')
  assert.equal(ahead.legible, 1, 'a 0.5 m piece at 5 m is 49.5 px of radius and is not legible')
  assert.ok(Math.abs(ahead.nearest - 5) < 1e-6, `the probe measures the nearest piece at ${ahead.nearest} m, which is not 5`)

  // Behind the lens, ninety degrees off, and past the far plane: the negative
  // controls. A probe that counted any of these would inflate every view in the
  // gallery, because the world holds three wrapped copies of every piece and two
  // of them are always behind the camera.
  assert.equal(sightlineAt(camera, at(0, 1.75, 5), unit, minPx).onScreen, 0, 'a piece behind the lens is in frame')
  assert.equal(sightlineAt(camera, at(-5, 1.75, 0), unit, minPx).onScreen, 0, 'a piece 90 degrees off the axis is in frame')
  assert.equal(
    sightlineAt(camera, at(0, 1.75, -300), unit, minPx).onScreen,
    0,
    'a piece 300 m away is in frame, past a 260 m far plane',
  )

  // FAR enough to be invisible, NEAR enough to be in the frustum: the case the
  // legibility floor exists for. 100 m is inside the frustum and reports
  // `onScreen: 1`, but a 0.5 m sphere there is 2.5 px of radius, under the 3 px
  // floor. This is the distinction the whole floor turns on, and a probe that
  // only counted frustum membership would call this piece visible.
  const far = sightlineAt(camera, at(0, 1.75, -100), unit, minPx)
  assert.equal(far.onScreen, 1, 'a piece 100 m ahead should still be in the frustum')
  assert.equal(far.legible, 0, 'a 0.5 m piece 100 m away is 2.5 px of radius and is being called legible')

  // ...and the floor is load-bearing in the other direction too: 20 m is 12.4 px,
  // comfortably over it. If this ever fails, the threshold has moved somewhere it
  // should not have.
  const mid = sightlineAt(camera, at(0, 1.75, -20), unit, minPx)
  assert.equal(mid.legible, 1, 'a 0.5 m piece 20 m away is 12.4 px of radius and is being called sub-pixel')
  assert.ok(
    Math.abs(mid.nearest - 20) < 1e-6 && Math.abs(far.nearest - 100) < 1e-6,
    'the probe reports one distance for two pieces at 20 m and 100 m',
  )

  // THE CAMERA TRANSFORM IS ACTUALLY BEING APPLIED.
  //
  // The six controls above are all satisfied by a probe that IGNORES the view
  // matrix, and that is not hypothetical: swapping `camera.matrixWorldInverse` for
  // an identity matrix leaves every one of them green. A point at (0, 1.75, -5) is
  // already 5 m "in front" in world space, so `depth = -z` is still 5, and the
  // projection puts it at NDC (0, 0.48) — inside the frame, control after control.
  // The only thing that gives the game away is a piece that is 5 m in front of the
  // CAMERA and therefore somewhere else entirely in WORLD space, which needs the
  // transform to be found at all.
  //
  // This is the assertion that separates a probe reading the camera from a probe
  // reading a constant, and it is why the positive control at the top is not the
  // whole test: "sees something straight ahead" is satisfiable by a probe that has
  // never been told where straight ahead is.
  const turned = new THREE.PerspectiveCamera(72, 1280 / 720, 0.05, 260)
  turned.height = 720
  turned.position.set(0, 1.75, 0)
  // A quarter turn about Y: the world point 5 m along -Z is now 5 m to the SIDE,
  // and the world point 5 m along -X is what is dead ahead.
  turned.rotation.set(0, Math.PI / 2, 0)
  turned.updateMatrixWorld(true)
  assert.equal(
    sightlineAt(turned, at(0, 1.75, -5), unit, minPx).onScreen,
    0,
    'the probe still sees a piece that a 90-degree camera rotation moved out of frame',
  )
  assert.equal(
    sightlineAt(turned, at(-5, 1.75, 0), unit, minPx).onScreen,
    1,
    'a piece the 90-degree turn brought into frame is not seen, so the view matrix is not applied',
  )
  assert.ok(
    Math.abs(sightlineAt(turned, at(-5, 1.75, 0), unit, minPx).nearest - 5) < 1e-6,
    'the rotated camera measures the wrong distance to the piece in front of it',
  )
})

check('pass-7 furniture stands where the §16.5 stand-offs are pointing', () => {
  // The reason the gallery could be empty, measured rather than guessed.
  //
  // Every pass-7 check above asks whether a piece is LEGAL: on the pavement, off
  // the carriageway, clear of a portal's 12 m. None asks whether any of it is
  // anywhere near the fourteen camera positions — and the fourteen are all on one
  // intersection, because `STREET_NODE` is `{ax: 1, az: 1}` and six views stand on
  // the lamp standing on it. So the whole gallery photographs a single corner of a
  // 448 m wrapped world, and pass 7's placement rules gave it no reason to put
  // anything on THAT corner.
  //
  // The point of the check is not a number high enough to look good in a README.
  // It is the DIRECTION: a pass that moves the dressing off the anchor lots, or
  // stops placing machines on the two blocks around the node, has to fail here
  // rather than in a gallery nobody re-opened.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const node = hood.streetNodeToWorld(hood.streetNodeId(1, 1))
  const at = canonicalXZ(node.x, node.z)
  // The count is taken CANONICALLY, folded with `hood.canonicalCoord`, because the
  // instances are in drawn coordinates and the node may be in any of the three
  // copies. Measuring a drawn instance against a canonical node without folding
  // invents a 448 m error and reports every family as absent — which is the exact
  // shape of the false negative this check must avoid, since its subject IS
  // absence.
  const near = (name, metres) => instances(view.pools[name]).filter((piece) => {
    const folded = canonicalXZ(piece.x, piece.z)
    return Math.hypot(folded.x - at.x, folded.z - at.z) < metres
  })
  // The three families a reader can name at 30-45 m, each with the distance its
  // own geometry earns. These are not arbitrary: a pixel radius is
  // `radius * focal / distance` with a focal of 495 px at 720p, so a family is
  // legible at a stated distance only if its bounding radius is big enough, and
  // the three radii here are 0.06 m (a bin's smallest part — a CASTOR, which is
  // why the bin's family measurement is 46 m out and still 5 px), 0.79 m (a
  // machine's body) and 0.16 m (a poster sheet, 0.42 x 0.60 x 0.01 seen flat).
  //
  // Each bound is the family's OWN measured reach, not one number for all of
  // them, and that is the point: a single "is there furniture near the node"
  // check would pass on the bollards — 948 of them, 24 m away, legible at 12 m —
  // and say nothing at all about a bin 46 m off or a shelter 132 m off. A check
  // that cannot tell a shelter from a bollard is not measuring the street.
  //
  // Bollards are EXCLUDED from the bounds on purpose, for the reason above, and
  // asserted separately below at a distance that is actually legible for them.
  for (const [name, metres] of [['dumpsters', 50], ['vendingBodies', 80], ['posters', 35]]) {
    const found = near(name, metres).length
    assert.ok(
      found > 0,
      `no ${name} within ${metres} m of the node all fourteen views stand on: the gallery photographs an empty kerb`,
    )
  }
  // Bollards: 18 within 30 m on this seed, and legible at 12 m. The bound is on
  // the COUNT rather than on presence, because they are the one family the pass
  // can drown the frame with — 148 of them are inside `street`'s frustum — and a
  // check that only asked "is one there" would be satisfied by a world with one.
  //
  // Eighteen, not one, and not a hundred. The number is the measured count at the
  // stated radius, so it is a claim about this seed that a placement change has to
  // answer for; and it is well under the 148 the frustum holds, so it is not
  // measuring the same thing twice. A pass that thinned the kerb to a single post
  // per intersection would fail here while every rate-based check still passed.
  assert.ok(
    near('bollards', 30).length >= 15,
    `only ${near('bollards', 30).length} bollards within 30 m of the node, so the kerb it photographs is bare`,
  )
  // A bike and a shelter are the two families furthest from the corner, and they
  // are the two a reader looks for LAST. They are asserted at the distance where
  // they are actually visible rather than at 45 m, because 45 m is 3 px of a bike
  // bar and nobody has ever identified a bicycle frame as a 3-pixel smudge. These
  // are the honest numbers, and stating them is the point: the gallery shows a
  // shelter at 132 m and a bike at 121 m, which is *in frame* and is NOT the same
  // as legible. A gate that conflated the two would pass a frame where the only
  // thing on it is a 3-pixel bar.
  assert.ok(
    near('shelterSteel', 140).length >= 4,
    'there is no shelter anywhere near the node every view in the gallery stands on',
  )
  assert.ok(near('bikeFrames', 130).length >= 5, 'there is no bicycle anywhere near the photographed corner')
  // Printed as well as asserted, because this is the number a reviewer should
  // have when they ask "how much furniture is around the photographed corner".
  const rows = ['dumpsters', 'trashBags', 'vendingBodies', 'shelterSteel', 'bikeFrames', 'bollards', 'posters']
    .map((name) => `${name} ${near(name, 45).length}/${view.pools[name].used}`)
  console.log(`\n  pass-7 furniture within 45 m of the §16.5 node: ${rows.join(', ')}`)
})

// ---------------------------------------------------------------------------
// PASS 8 — WATER & REFLECTIONS
//
// Six checks, in the order the pass's claims are stated, so a failure names the
// claim it broke rather than a symptom of it:
//
//   1. every pool is placed, instanced, committed, and inside the triangle
//      budget — the pass's cost claim
//   2. every puddle is in a band, and every band is somewhere that band exists
//      — the brief's "natural spots"
//   3. every drop of water is INSIDE the carriageway — the pass's own bug, and
//      the check that was missing when it was written
//   4. the halo is bigger, lower and darker than the water it darkens around
//   5. the streak is additive, warm, elongated, and one per lamp — the
//      reflection claim, and the eye-gate arithmetic
//   6. the canal crosses a street, is a channel and not a stripe, and shimmers
//      on the clock
// ---------------------------------------------------------------------------

/**
 * `roadDistance` — metres from a drawn point to the nearest road centreline.
 *
 * The road lattice is seven axes 64 m apart and it REPEATS every `WORLD_EXTENT`,
 * so the distance has to fold by the period before it means anything. The first
 * version of this helper did not, and it reported 21 puddles "in a block" that
 * were in fact 2.1 m from a kerb 448 m away — the frame error `canonicalXZ`'s own
 * comment warns about, arrived at from the other direction. A gate that invents
 * a defect is worse than no gate, because the repair is to delete it.
 *
 * @param {number} v a drawn coordinate on one axis
 * @returns {number} metres to the nearest centreline
 */
function roadDistance(v) {
  let best = Infinity
  for (let period = -1; period <= 1; period += 1) {
    for (let axis = 0; axis < hood.GRID; axis += 1) {
      const gap = Math.abs(v - (hood.roadAxisToWorld(axis) + period * hood.WORLD_EXTENT))
      if (gap < best) best = gap
    }
  }
  return best
}

/** Is this drawn piece inside a carriageway, allowing for its own size? */
function onCarriageway(piece) {
  return (
    roadDistance(piece.x) + piece.sx / 2 <= hood.STREET_HALF_WIDTH ||
    roadDistance(piece.z) + piece.sz / 2 <= hood.STREET_HALF_WIDTH
  )
}

/**
 * How far this piece's nearest edge spills past the kerb face. Negative is inside.
 *
 * The BEST axis and not the worst, and the first version of this took the worst —
 * which is a gate that invents a defect rather than one that finds one. A piece
 * lying on a north-south road is 14 m from the nearest east-west centreline, and
 * that is not a spill: it is a road. `min` of the two sums is the only reading
 * under which "or" in `onCarriageway` and "how far past the kerb" agree, and the
 * two have to agree or the message reports a distance from the wrong axis.
 */
function kerbSpill(piece) {
  return hood.STREET_HALF_WIDTH - Math.min(
    roadDistance(piece.x) + piece.sx / 2,
    roadDistance(piece.z) + piece.sz / 2,
  )
}

/** Rec. 709 luma of a packed 0xRRGGBB — the measure the palette comments quote. */
function packedLuma(hex) {
  return 0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)
}

/**
 * `waterNumber` — a named constant out of `streetView.js`, read from the source.
 *
 * The same reason `verify.mjs` has `buildingNumber`: the check and the thing it
 * checks cannot then disagree about what the number is. It is NOT a re-derivation
 * — the values are read, not recomputed from the geometry — because the point of
 * several of these assertions is that the constant and the placement agree, and a
 * helper that re-derived one from the other would be checking itself.
 *
 * @param {string} name the constant's name, without `const`
 * @returns {number} its value
 */
function waterNumber(name) {
  const found = new RegExp(`const ${name} = ([\\d.]+)`).exec(STREET_VIEW_SOURCE)
  assert.ok(found, `${name} is not a named constant any more, so this check is reading nothing`)
  return Number(found[1])
}

/** Position and scale of an instance, as one object. */
function placed(pool) {
  const where = instances(pool)
  const size = scales(pool)
  return where.map((piece, i) => ({ ...piece, sx: size[i].sx, sy: size[i].sy, sz: size[i].sz }))
}

check('pass-8 water is placed, instanced, committed, and inside the triangle budget', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  for (const name of PASS8_POOLS) {
    const pool = view.pools[name]
    assert.ok(pool, `the pool ${name} does not exist, so this pass is not in the build`)
    assert.ok(pool.mesh.isInstancedMesh, `${name} is not an InstancedMesh, so it is a scene graph of ${pool.capacity} objects`)
    assert.ok(pool.used > 0, `${name} placed nothing at all`)
    assert.equal(pool.overflow, 0, `${name} overflowed and dropped ${pool.overflow} instances`)
    assert.equal(pool.mesh.count, pool.used, `${name} was never committed, so its instances were never uploaded`)
  }
  // The budget as a number rather than a claim. A puddle is a 10-gon (20
  // triangles) and a streak is a quad, and the whole point of the pass's
  // geometry argument is that this stays small: the five pools together are
  // under 8,000 triangles, a twentieth of what a smooth pond would cost for the
  // same picture.
  let triangles = 0
  for (const name of PASS8_POOLS) {
    const geometry = view.pools[name].mesh.geometry
    const per = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
    triangles += view.pools[name].used * per
  }
  assert.ok(triangles < 8000, `the water costs ${triangles} triangles, over the 8,000 this pass budgeted`)
  // ...and the halo and the water are the SAME geometry object, which is the
  // second half of the cost argument: two pools holding one `BufferGeometry` is
  // one upload and one VRAM copy, and two pools holding two is two of each.
  assert.equal(
    view.pools.puddles.mesh.geometry,
    view.pools.wetSheen.mesh.geometry,
    'the halo and the water do not share one geometry, so the pass pays for the same 20 triangles twice',
  )
  // The discs are 10-gons, and a puddle is never a pond. The count is read off
  // the BUILT geometry rather than the source, so a change to the segment count
  // has to be made in both places or it fails here.
  assert.equal(
    view.pools.puddles.mesh.geometry.attributes.position.count,
    12,
    `the puddle disc has ${view.pools.puddles.mesh.geometry.attributes.position.count} vertices, so PUDDLE_SEGMENTS is not the 10 the triangle budget assumes`,
  )
  console.log(`\n  pass-8 water: ${triangles} triangles across ${PASS8_POOLS.length} pools`)
})

check('every puddle is in a band, and every band is somewhere that band exists', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const puddles = view.waterLog.filter((entry) => entry.kind === 'puddle')
  assert.ok(puddles.length > 0, 'the world has no puddles at all')
  // The LOG is the subject, not the geometry, for the reason `waterLog` gives:
  // all three bands are legal road positions, so a geometric check cannot tell
  // which rule placed a puddle. The band is only recoverable from the record of
  // which rule ran — and "near a kerb" is true of a canal puddle too, which is
  // exactly the kind of tautology that looks green.
  const bands = [...new Set(puddles.map((entry) => entry.band))].sort()
  assert.deepEqual(bands, ['canal', 'crossing', 'gutter'], `the bands in use are ${bands}, and the brief asks for gutter lines, intersections and the drainage channel`)
  // ...and the LOG agrees with the GEOMETRY, entry for entry, which is what
  // makes it evidence rather than a second opinion. `waterLog` is written in the
  // drawn frame (the copy offset is already added) and so are the instances, so
  // this is an exact comparison with no fold involved.
  const drawn = placed(view.pools.puddles)
  assert.equal(drawn.length, puddles.length, `the log has ${puddles.length} puddles and the pool has ${drawn.length}`)
  for (let i = 0; i < puddles.length; i += 1) {
    assert.ok(Math.abs(drawn[i].x - puddles[i].x) < 1e-3, `puddle ${i} is logged at x=${puddles[i].x} and drawn at x=${drawn[i].x}`)
    assert.ok(Math.abs(drawn[i].z - puddles[i].z) < 1e-3, `puddle ${i} is logged at z=${puddles[i].z} and drawn at z=${drawn[i].z}`)
  }
  // The canal band exists at exactly one node, and that node is the §16.5 node
  // all fourteen photographs stand on. Canal-band puddles anywhere else would be
  // water in the middle of a road with no channel to justify it.
  for (const entry of puddles.filter((row) => row.band === 'canal')) {
    assert.equal(hood.streetNodeId(entry.ax, entry.az), hood.streetNodeId(1, 1), `a canal puddle sits at node (${entry.ax},${entry.az}) and the channel is at (1,1)`)
  }
  // ...and each of them is BESIDE THE DRAWN CHANNEL, which is the one assertion
  // in this pass that compares the two systems to each other. The band's claim is
  // that a trough is the one place on the street already below the water table,
  // so water there is standing IN something; a puddle thirty metres from the
  // nearest channel is a puddle wearing a channel's name, and the band check
  // cannot see it (it reads the log) and the channel check cannot either (it
  // reads the canal). The distance is taken from the drawn water instances, so
  // it is a measurement rather than the constant agreeing with itself — which is
  // the whole defect `CANAL_CANAL_OFFSET` is one edit away from.
  const canalWater = placed(view.pools.canalWater)
  const beside = waterNumber('CANAL_W') / 2 + waterNumber('CANAL_LIP_T') + waterNumber('PUDDLE_CANAL_SETBACK')
  for (const entry of puddles.filter((row) => row.band === 'canal')) {
    const near = Math.min(...canalWater.map((piece) => Math.abs(piece.x - entry.x)))
    assert.ok(
      Math.abs(near - beside) < 1e-3,
      `a canal-band puddle is ${near.toFixed(2)} m from the channel's water, and the band exists to be the ${beside.toFixed(2)} m beside it`,
    )
  }
  // Each band's radius is inside the room that band was GIVEN, and the rooms are
  // the same constants that positioned the bands. The gutter band is the tight
  // one and is the one that must be asserted by name: a gutter puddle 2.4 m
  // across is a pond lying on the footway, which is the bug this pass shipped
  // and then measured.
  for (const [band, name] of Object.entries({ gutter: 'PUDDLE_GUTTER_INSET', crossing: 'PUDDLE_CROSSING_OFFSET', canal: 'PUDDLE_CANAL_SETBACK' })) {
    const radii = puddles.filter((entry) => entry.band === band).map((entry) => entry.radius)
    if (radii.length === 0) continue
    const ceiling = waterNumber(name)
    assert.ok(Math.max(...radii) <= ceiling + 1e-6, `the widest ${band} puddle is ${Math.max(...radii).toFixed(2)} m and that band has ${ceiling} m of room`)
    assert.ok(Math.min(...radii) >= 0.5, `the narrowest ${band} puddle is ${Math.min(...radii).toFixed(2)} m, which is a smear rather than a puddle`)
  }
  // THE ROOMS ARE ORDERED, and it is the only claim in this check that is not
  // about one band on its own. Each band's room is the SAME constant that
  // positioned it, so `radius <= room` is an identity: it held on the build that
  // shipped the first version of this pass, with a third of the world's puddles
  // lying on the footway, because the room had grown along with the puddles. A
  // band that is merely RE-WIDENED (`PUDDLE_GUTTER_INSET` 0.70 -> 0.95) is
  // therefore invisible to every per-band identity above and leaves every puddle
  // still on the tarmac — the band simply stops being the feature it is named
  // after, and only a comparison BETWEEN bands can see that.
  //
  // The order is the street's and not an accident of three numbers: a gutter is a
  // kerb-side channel, the canal band is the shoulder beside a trough, and a
  // crossing puddle is in a wheel rut. Tightest to roomiest — gutter, canal,
  // crossing — and a band that inverts it has been given a room its feature does
  // not have, which is a puddle anywhere and a gutter puddle nowhere.
  const rooms = {
    gutter: waterNumber('PUDDLE_GUTTER_INSET'),
    canal: waterNumber('PUDDLE_CANAL_SETBACK'),
    crossing: waterNumber('PUDDLE_CROSSING_OFFSET'),
  }
  assert.ok(
    rooms.gutter < rooms.canal,
    `the gutter band has ${rooms.gutter} m of room and the canal band ${rooms.canal} m, so the tightest water on the street is the trough's shoulder and not the gutter`,
  )
  assert.ok(
    rooms.canal < rooms.crossing,
    `the canal band has ${rooms.canal} m of room and the crossing band ${rooms.crossing} m, so a puddle beside the channel is wider than one in a wheel rut`,
  )
  // The rate is a RATE and not a cap, which is the difference between a street
  // and a pattern: three populations, and a continuous draw inside each.
  const crossings = puddles.filter((entry) => entry.band === 'crossing').map((entry) => entry.radius)
  const distinct = new Set(crossings.map((r) => r.toFixed(3))).size
  assert.ok(distinct > 20, `${distinct} distinct crossing radii, which is not a continuous draw`)
  const tally = ['gutter', 'crossing', 'canal'].map((band) => `${band} ${puddles.filter((e) => e.band === band).length}`).join(', ')
  console.log(`\n  pass-8 puddles: ${puddles.length} — ${tally}`)
})

check('no drop of water is on the pavement: every puddle and streak is in the road', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  // This is the check whose absence let a third of the world's puddles sit on
  // the footway, and the first version of it measured the wrong thing. Two
  // distinct claims are involved and BOTH have to hold:
  //
  //   - a puddle is inside the carriageway (this check), and
  //   - a piece of furniture is OUTSIDE it (the pass-6 check above).
  //
  // A world can satisfy either alone and look wrong in both directions, and
  // this pass broke the first one only because the radius was drawn globally
  // rather than per band.
  let worst = Infinity
  for (const name of ['puddles', 'streaks']) {
    const pieces = placed(view.pools[name])
    assert.ok(pieces.length > 0, `${name} placed nothing, so this check would pass vacuously`)
    for (let i = 0; i < pieces.length; i += 1) {
      const spill = kerbSpill(pieces[i])
      if (spill < worst) worst = spill
      assert.ok(
        onCarriageway(pieces[i]),
        `${name} ${i} is ${(-spill).toFixed(2)} m past the kerb: ` +
          `${roadDistance(pieces[i].x).toFixed(2)} m from the nearest x centreline, ` +
          `${roadDistance(pieces[i].z).toFixed(2)} from the nearest z, and the carriageway is ${hood.STREET_HALF_WIDTH} m either side`,
      )
    }
  }
  // The wet halo is DELIBERATELY allowed past the kerb, because a damp road
  // fades out over 0.7 m and the fade is the whole point — so it gets a
  // separate, weaker bound rather than being folded into the one above. A halo
  // that stopped sharply at the kerb would be a visible disc edge on the
  // pavement, which is the artefact the halo exists to avoid.
  for (const piece of placed(view.pools.wetSheen)) {
    assert.ok(kerbSpill(piece) > -1.6, `a wet halo reaches ${(-kerbSpill(piece)).toFixed(2)} m past the kerb, which is a damp road reaching onto the footway`)
  }
  // ...and the GUTTER band is measured against the KERB FACE rather than against
  // the constant that placed it. A band's room and the place the band is put are
  // one number, so every radius-versus-that-number comparison above is the code
  // agreeing with itself; the only free measurement is the one taken off the
  // drawn frame, and this is it. Per instance: how much road is left between
  // this puddle and the kerb, and does the puddle fit in it.
  //
  // It catches the direction that IS reachable by editing one side — a band moved
  // off the kerb with its bound left behind, which is how a row of discs ends up
  // in the middle of the carriageway wearing a gutter's name. Widening the band
  // and its bound together is NOT caught here and is not supposed to be: that is
  // the band check's room ordering, one file section up.
  const gutterRoom = waterNumber('PUDDLE_GUTTER_INSET')
  const gutterPuddles = view.waterLog.filter((row) => row.kind === 'puddle' && row.band === 'gutter')
  assert.ok(gutterPuddles.length > 0, 'the gutter band placed nothing, so this measurement is vacuous')
  for (const entry of gutterPuddles) {
    const room = hood.STREET_HALF_WIDTH - Math.min(roadDistance(entry.x), roadDistance(entry.z))
    assert.ok(
      Math.abs(room - gutterRoom) < 1e-3,
      `a gutter puddle at (${entry.x.toFixed(1)},${entry.z.toFixed(1)}) has ${room.toFixed(2)} m of road between it and the kerb, and the band was given ${gutterRoom} m`,
    )
    assert.ok(entry.radius <= room + 1e-6, `a gutter puddle is ${entry.radius.toFixed(2)} m in a ${room.toFixed(2)} m gutter, so it is wider than the gutter it is in`)
  }
  console.log(`\n  pass-8 clearance: worst water ${worst.toFixed(2)} m inside the kerb over ${placed(view.pools.puddles).length} puddles + ${placed(view.pools.streaks).length} streaks`)
})

check('the wet halo is bigger, lower and darker than the water it darkens around', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  // ONE halo per puddle, written in the same call, and the count IS the claim. A
  // halo pool that drifted out of step — a puddle whose halo was dropped by an
  // over-capacity pool — would be a bright disc on dry road, and the brief's
  // "wet-road darkening near the puddles" is exactly what would be missing.
  assert.equal(
    view.pools.wetSheen.used,
    view.pools.puddles.used,
    `${view.pools.wetSheen.used} halos for ${view.pools.puddles.used} puddles, so some water is standing on dry road`,
  )
  const water = placed(view.pools.puddles)
  const halo = placed(view.pools.wetSheen)
  for (let i = 0; i < water.length; i += 1) {
    assert.ok(Math.abs(water[i].x - halo[i].x) < 1e-3, `halo ${i} is not under puddle ${i}`)
    assert.ok(Math.abs(water[i].z - halo[i].z) < 1e-3, `halo ${i} is not under puddle ${i}`)
    assert.ok(halo[i].y < water[i].y, `halo ${i} is at y=${halo[i].y} and the water at ${water[i].y}, so the damp is drawn on top of the puddle`)
    // `PUDDLE_HALO_SPREAD` on BOTH axes, not one: an oval halo on a round
    // puddle reads as a shadow, and a round halo on an oval puddle is invisible.
    assert.ok(halo[i].sx > water[i].sx * 1.5, `halo ${i} is ${halo[i].sx.toFixed(2)} m across and the water ${water[i].sx.toFixed(2)}`)
    assert.ok(halo[i].sz > water[i].sz * 1.5, `halo ${i} is not wider than its puddle across the short axis`)
  }
  // The halo is a BLEND, not a disc of paint: transparent, an opacity under 1,
  // and no depth write. At 1.0 it would be a painted circle of `wetSheen` and
  // the sodium pool would stop landing on the road.
  const sheen = view._materials.wetSheen
  assert.equal(sheen.transparent, true, 'the wet halo is not transparent, so it is paint rather than damp')
  assert.ok(sheen.opacity > 0.2 && sheen.opacity < 0.8, `the halo blends at ${sheen.opacity}, which is either invisible or opaque`)
  assert.equal(sheen.depthWrite, false, 'the halo writes depth, so it can occlude the puddle above it')
  // ...and it is DARKER than the asphalt, which is the brief's "wet-road
  // darkening" stated as a number rather than as a name. A wet road goes dark
  // because the water film takes away the diffuse bounce; a puddle lighter than
  // the road around it is a puddle of paint.
  assert.ok(
    lumaOf(sheen.color) < lumaOf(view._materials.asphalt.color),
    `the wet halo is luma ${lumaOf(sheen.color).toFixed(1)} and the asphalt ${lumaOf(view._materials.asphalt.color).toFixed(1)}, so a wet road would be a dry one with a stain on it`,
  )
  // THE RENDER ORDERS, which are the pass's own and which three.js would
  // otherwise decide by depth: at 11 m all four water surfaces are within 2 m of
  // each other, and left to the automatic sort the additive streak lands UNDER
  // the dark halo on roughly half the frames — a reflection that vanishes when
  // the camera moves, which no single screenshot reveals.
  const order = ['wetSheen', 'puddles', 'canalWater', 'streaks'].map((name) => view.pools[name].mesh.renderOrder)
  assert.deepEqual(order, [1, 2, 3, 4], `the water render order is ${order}, and it must be halo, puddle, canal, streak`)
})

check('the streak is one additive warm quad per lamp, and it cannot become an eye', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  // ONE PER LAMP, and the count is a function of the lamp grid rather than of
  // the puddles. A per-puddle scheme would place several hundred, and a reviewer
  // reading `streaks.used` could not tell which rule produced the number.
  assert.equal(
    view.pools.streaks.used,
    view.lampPositions.length * 3,
    `${view.pools.streaks.used} streaks for ${view.lampPositions.length} lamps in three copies, so the reflection is not one per light`,
  )
  // ADDITIVE and unfogged-bright is what makes it a light rather than a painted
  // stripe; `fog: true` because it lies on the ground and has to recede, which
  // is the same combination as the sodium pool it reflects.
  const material = view._materials.streak
  assert.equal(material.blending, 2, 'the streak is not additive, so it is a decal and not a reflection')
  assert.equal(material.fog, true, 'the streak is unfogged, so a reflection is visible from the far end of an avenue')
  assert.equal(material.depthWrite, false, 'the streak writes depth, so it can occlude the puddle it reflects in')
  // WARM, and this is the palette authority the brief names: §12.2 is explicit
  // that cyan belongs to the portals alone, so a blue reflection would be a
  // second cold light family in a game that has exactly one.
  const { r, g, b } = material.color
  assert.ok(r > g && g > b, `the reflection is rgb(${r},${g},${b}), which is not a warm amber`)
  // ELONGATED, and the RATIO is the claim rather than the two numbers: a disc is
  // a mirror and a smear is a reflection in a rough surface, and 1 x 9 is 9:1
  // whichever way round it is measured.
  const sizes = scales(view.pools.streaks)
  for (const piece of sizes) {
    assert.ok(Math.max(piece.sx, piece.sz) / Math.min(piece.sx, piece.sz) > 4, `a streak is ${piece.sx.toFixed(2)} x ${piece.sz.toFixed(2)} m, which is not a streak`)
  }
  // ...and BOTH axes occur, so the world is not a comb of parallel streaks. The
  // axis is a per-node hash precisely so that it is not.
  const alongX = sizes.filter((piece) => piece.sx > piece.sz).length
  assert.ok(alongX > 0 && alongX < sizes.length, `${alongX} of ${sizes.length} streaks run along x, so every lamp in the world reflects the same way`)
  // THE EYE ARITHMETIC, and it is the reason the streak is drawn at `STREAK_PEAK`
  // rather than at full `waterStreak`. `tools/png-luma.mjs` finds the creature's
  // eye by flood-filling compact blobs at or above `EYE_MIN`, and a warm additive
  // quad on the ground is exactly the sort of thing that becomes one. Asserted
  // here as a MATERIAL fact and in `verify.mjs` as arithmetic against the same
  // constant, so the number cannot drift above the threshold in one place and
  // not in the other.
  assert.ok(material.map, 'the streak has no falloff texture, so it is a hard-edged rectangle of light on the road')
  // `lumaOf` takes a `THREE.Color` and does the sRGB ENCODE, which is the form the
  // eye finder measures in — a raw 0-1 average would read 0.30 where the frame
  // reads 194, and a gate written that way passes a streak that blows the eye
  // gate. The first version of this line divided an already-normalised colour by
  // 255 a second time and reported a peak of 4.0, which is green and passed.
  const peak = lumaOf(material.color) * waterNumber('STREAK_PEAK')
  assert.ok(peak < 150, `a streak peaks at luma ${peak.toFixed(1)} and EYE_MIN is 150, so a reflection can be found as the creature's eye`)
  // ...and not trivially under it either, because a floor is the other half of a
  // bound: a streak at luma 4 is not a reflection, it is a rounding error, and
  // the assertion above would have called that a pass.
  assert.ok(peak > 60, `a streak peaks at luma ${peak.toFixed(1)}, too dim to read as a reflection of a ${lumaOf(view._materials.sodium.color).toFixed(0)} lamp head`)
  console.log(`\n  pass-8 streak: ${sizes.length} quads, ${alongX} along x, peak luma ${peak.toFixed(1)} against EYE_MIN 150`)
})

check('the canal crosses a street, is a channel and not a stripe, and shimmers on the clock', () => {
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  // ONE channel per wrapped copy, and it is the SAME channel: three instances
  // exactly `WORLD_EXTENT` apart. A canal scattered per node would be a puddle
  // field wearing a channel's name, and the brief asks for ONE.
  const water = placed(view.pools.canalWater)
  const lips = placed(view.pools.canalLips)
  assert.equal(water.length, 3, `the world has ${water.length} channels and the brief asks for one`)
  assert.equal(lips.length, 6, `the channel has ${lips.length} lips and a channel is two`)
  for (let copy = 1; copy < 3; copy += 1) {
    // CONSECUTIVE pairs, and not "each against the first": the copies are laid
    // down at -448, 0 and +448, so the third is two periods from the first. The
    // first version compared every copy to copy 0 and reported 896 m for a
    // channel that is 448 m from its neighbour — a gate that cannot count.
    //
    // The offset is on X, not z, because the channel runs ALONG z and the copies
    // differ on the axis PERPENDICULAR to the run. Checking z (as an earlier
    // version did) reports 0 m, because all three copies genuinely share a z.
    assert.ok(Math.abs(Math.abs(water[copy].x - water[copy - 1].x) - hood.WORLD_EXTENT) < 1e-3, `copy ${copy} is ${Math.abs(water[copy].x - water[copy - 1].x)} m from copy ${copy - 1}, which is not one world period`)
  }
  // IT CROSSES A STREET. The channel's long axis is perpendicular to the road it
  // crosses and its centre passes within the carriageway — the first version of
  // this pass ran the channel ALONG the street, 21 m from the nearest
  // centreline, which put 26 m of standing water in the middle of a block
  // between two houses. Every count was right and the water was in the scene.
  const long = Math.max(lips[2].sx, lips[2].sz)
  assert.ok(roadDistance(water[1].z) <= hood.STREET_HALF_WIDTH, `the channel crosses the street ${roadDistance(water[1].z).toFixed(1)} m from its centreline, which is off the road entirely`)
  assert.ok(long > hood.STREET_HALF_WIDTH * 2, `the channel is ${long.toFixed(1)} m long, which does not span the ${hood.STREET_HALF_WIDTH * 2} m carriageway it crosses`)
  // ...and it is dug in the BLOCK of the junction it drains, which is what makes
  // it a feature of this street rather than a channel somewhere on the map. A
  // drainage channel belongs to the block it runs down — half the road spacing
  // either side of the node — and everything this pass built for it lives there:
  // the canal-band puddles, which are only placed at `CANAL_NODE`, and the
  // fourteen captures, which all stand on that same node. `CANAL_CANAL_OFFSET` is
  // one edit from 9 m to a number that carries the channel and its puddles
  // together into the next block, where every count above is still correct, the
  // channel still crosses streets, and nothing photographs it.
  //
  // The bound is the DERIVED spacing and not a number typed in here, so it moves
  // with the map, and the comparison is per copy because the copies are a
  // `WORLD_EXTENT` apart and a copy-2 channel is not 440 m from its own node.
  const canalNode = hood.streetNodeToWorld(hood.streetNodeId(1, 1))
  const spacing = Math.abs(hood.roadAxisToWorld(1) - hood.roadAxisToWorld(0))
  for (const row of view.waterLog.filter((entry) => entry.kind === 'canal')) {
    const off = Math.abs(row.x - (canalNode.x + row.copy * hood.WORLD_EXTENT))
    assert.ok(off < spacing / 2, `copy ${row.copy}'s channel is ${off.toFixed(1)} m from the junction it drains, and a block is half a road spacing, ${(spacing / 2).toFixed(1)} m`)
  }
  // A CHANNEL AND NOT A STRIPE: the lips have HEIGHT, and that is the only thing
  // giving the water an edge to sit behind. A flat dark line on a road is a
  // painted line, and no amount of shimmer makes it water.
  for (const lip of lips) {
    assert.ok(lip.sy > 0.05, `a lip is ${lip.sy.toFixed(3)} m tall, so the channel has no wall to sit in`)
  }
  // The water is BELOW both lips and ABOVE the road, and it is the DERIVED
  // difference rather than a third independent number: writing `0.01` literally
  // left `CANAL_DEPTH` unused, and a later edit to the lip height would have
  // left the water floating in its own channel with nothing failing.
  const lipTop = lips[0].y + lips[0].sy / 2
  const derived = waterNumber('CANAL_LIP_H') - waterNumber('CANAL_DEPTH')
  for (const piece of water) {
    assert.ok(piece.y < lipTop, `the canal's water is at y=${piece.y.toFixed(3)} and the lip tops are at ${lipTop.toFixed(3)}, so the water is above its own walls`)
    assert.ok(piece.y > 0, `the canal's water is at y=${piece.y.toFixed(3)}, which is below the road plane it is cut into`)
    assert.ok(Math.abs(piece.y - derived) < 1e-3, `the canal's water is at ${piece.y.toFixed(4)} and CANAL_LIP_H - CANAL_DEPTH is ${derived.toFixed(4)}`)
  }
  // The two lips are `CANAL_W` apart on their INNER faces, so the channel is
  // exactly as wide as the water in it. A channel narrower than its own water is
  // water running through a wall.
  const inner = Math.abs(lips[0].x - lips[1].x) - lips[0].sx
  assert.ok(Math.abs(inner - waterNumber('CANAL_W')) < 1e-3, `the channel's inner width is ${inner.toFixed(3)} m and CANAL_W is ${waterNumber('CANAL_W')}`)
  // ...and darker than the road it is cut into, or the channel is a light stripe.
  assert.ok(
    lumaOf(view._materials.canalWater.color) < lumaOf(view._materials.asphalt.color),
    'the canal is lighter than the road, so a channel is a painted stripe',
  )
  // It is a lit SURFACE with fog on and not a `_glow`: an unfogged water surface
  // is visible from the far end of the avenue, which is the same fault
  // `vendingFaceLit` was fixed for.
  assert.equal(view._materials.canalWater.type, 'MeshStandardMaterial', 'the canal is not a lit surface')
  assert.equal(view._materials.canalWater.fog, true, 'the canal is unfogged')
  // THE SHIMMER, the only animated thing in the pass. Driven off `this._time` and
  // not off an accumulated `dt`, so a capture that steps to a given time gets a
  // given shimmer — and so the determinism check below can exist at all.
  const map = view._materials.canalWater.map
  assert.ok(map, 'the canal has no map, so its surface cannot shimmer')
  // The offset asserted below is only MEANINGFUL if the map repeats along the
  // channel, and this is the assertion that says so. Clamped, the scroll is not a
  // scroll: the last tile smears down the whole 26 m of water and the canal stops
  // shimmering and starts stretching. `CANAL_SHIMMER_TILES` copies of a tile on a
  // channel `CANAL_LEN` long only tile if the length axis wraps, so the wrap is
  // the claim and the scrolling offset is the consequence of it.
  assert.equal(map.wrapS, THREE.RepeatWrapping, `the canal's map wraps its length as ${map.wrapS}, so a shimmer scroll smears one tile down the whole channel`)
  // THE U AXIS IS THE LONG ONE, and this is the gate the pass shipped without.
  //
  // `update()` scrolls `map.offset.x`, and a texture's U axis is its X axis, so
  // the scroll runs along whichever LOCAL axis the water plane's U follows. The
  // plane was laid down with `rotateX(-PI/2)` alone, which puts U on the local X
  // — the axis `place()` scales by `CANAL_W` (1.1 m), the channel's WIDTH. The
  // scroll was therefore running sideways across a 1.1 m trough, while the
  // divisor in `update()` is `CANAL_LEN / CANAL_SHIMMER_TILES` = 3.71 m, a
  // length that only exists along the channel: the ground speed was
  // 0.06 x (1.1/26) = 0.0025 m/s, 23.6x slower than the constant says, and 90
  // degrees away from "water moves down the channel".
  //
  // EVERY COUNT ABOVE PASSED with the plane flat, which is why this is measured
  // rather than reasoned: the water was in the right place, at the right lift,
  // the right width, the right colour and the right render order. Nothing about
  // the SHIMMER's axis is visible to any of them, and a wrong axis reads on
  // screen as water that is simply still — indistinguishable from "slow", which
  // is the very property the pass was after.
  //
  // Read off the BUILT geometry, not the source: the claim is which local axis U
  // follows, and the source may lay the plane down any way it likes as long as
  // the two agree.
  const uv = view.pools.canalWater.mesh.geometry.attributes.uv
  const pos = view.pools.canalWater.mesh.geometry.attributes.position
  let uOnX = 0
  let uOnZ = 0
  for (let i = 0; i < uv.count; i += 1) {
    if (uv.getX(i) !== 0) continue
    // v0 is the U=0 row; its partner is the far corner at the same V.
    const partner = [...Array(uv.count).keys()].find(
      (j) => j !== i && Math.abs(uv.getY(j) - uv.getY(i)) < 1e-6 && uv.getX(j) === 1,
    )
    if (partner === undefined) continue
    const dx = Math.abs(pos.getX(partner) - pos.getX(i))
    const dz = Math.abs(pos.getZ(partner) - pos.getZ(i))
    if (dx > 1e-6 && dz <= 1e-6) uOnX += 1
    if (dz > 1e-6 && dx <= 1e-6) uOnZ += 1
  }
  assert.ok(
    uOnZ > 0 && uOnX === 0,
    `the canal's U axis follows the local ${uOnX > 0 ? 'X' : 'neither'} axis, and local X is the ${waterNumber('CANAL_W')} m width, so the shimmer scrolls across the channel instead of down it`,
  )
  // ...and the consequence as a MEASUREMENT rather than as a direction, because
  // the direction is the easy half to state and the LENGTH is what the constant
  // `CANAL_SHIMMER_MPS` is a speed OF. `update()` divides by
  // `CANAL_LEN / CANAL_SHIMMER_TILES`, which is only correct if one U tile
  // really does span that many METRES of world along U. So: take the local axis
  // U follows, scale it by that axis's instance scale, and require the world
  // length of one U tile to be the divisor's reciprocal.
  //
  // This is the half that catches the SPEED. The direction assertion above would
  // also pass on a plane whose U runs along Z but is scaled wrongly, and the
  // ground speed is a pure function of the ratio between the two lengths.
  const uLocalSpan = Math.max(
    Math.abs(pos.getX(1) - pos.getX(0)),
    Math.abs(pos.getZ(1) - pos.getZ(0)),
  )
  const uWorldSpan = uOnZ > 0 ? water[0].sz : water[0].sx
  const worldPerTile = (uWorldSpan * uLocalSpan) / map.repeat.x
  const wanted = waterNumber('CANAL_LEN') / waterNumber('CANAL_SHIMMER_TILES')
  assert.ok(
    Math.abs(worldPerTile - wanted) < 1e-3,
    `one shimmer tile spans ${worldPerTile.toFixed(3)} m of world along U and update() divides by ${wanted.toFixed(3)} m, so the water moves at ${(waterNumber('CANAL_SHIMMER_MPS') * wanted / worldPerTile).toFixed(4)} m/s rather than the ${waterNumber('CANAL_SHIMMER_MPS')} the constant promises`,
  )
  // The repeat count is what makes the tile that long, and it is set on U — so
  // with the axis right the repeat is 7 along the channel and 1 across it. A
  // repeat of 1 on U is a 26 m tile that never visibly scrolls.
  assert.ok(
    map.repeat.x >= 3,
    `the shimmer map repeats ${map.repeat.x} times along U, so one tile is ${(waterNumber('CANAL_LEN') / map.repeat.x).toFixed(1)} m and a scroll of ${waterNumber('CANAL_SHIMMER_MPS')} m/s takes ${(waterNumber('CANAL_LEN') / map.repeat.x / waterNumber('CANAL_SHIMMER_MPS')).toFixed(0)} s to cross it`,
  )
  const before = map.offset.x
  run(game, 4)
  const after = map.offset.x
  // The DELTA and not the absolute value, and the reason is that this file
  // drives ONE shared `game`: every check above has already called `run()`, so
  // `this._time` is tens of seconds old by the time this check runs. Comparing
  // the absolute offset against a four-second expectation reports a quarter of
  // a tile and fails; comparing the delta is the claim anyway, which is "four
  // seconds of play moved the water by this much".
  const moved = after - before
  const expected = 4 * waterNumber('CANAL_SHIMMER_MPS') / (waterNumber('CANAL_LEN') / waterNumber('CANAL_SHIMMER_TILES'))
  assert.ok(moved > 0, `four seconds of play moved the canal by ${moved.toFixed(4)}, so the shimmer is not running`)
  assert.ok(Math.abs(moved - expected) < 1e-6, `the canal moved ${moved.toFixed(4)} in 4 s and CANAL_SHIMMER_MPS implies ${expected.toFixed(4)}`)
  // SLOW: 4 s at 0.06 m/s is 0.24 m of a 3.7 m tile, so the water has not wrapped
  // and is nowhere near doing so. A scroll that wrapped inside four seconds is a
  // swimming pool, and this is the number that says which it is.
  assert.ok(moved < 0.2, `the canal moved ${moved.toFixed(3)} in 4 s, so the water moves faster than a canal moves`)
  // ...and the same time twice gives the same offset, bit for bit. An accumulator
  // that summed `dt` would drift by a different amount every run and this
  // assertion could not exist.
  view._time = 12.5
  view.update(0)
  const first = view._materials.canalWater.map.offset.x
  view._time = 0
  view.update(0)
  view._time = 12.5
  view.update(0)
  assert.equal(view._materials.canalWater.map.offset.x, first, 'two runs to t=12.5 gave two different shimmers, so the scroll is not a function of the clock')
  // THE PORTAL EXCLUSION, asked as a PREDICATE and not as a count. On this seed
  // no candidate spot falls within `PORTAL_FURNITURE_CLEAR` of a portal, so
  // `waterRejected` is 0 — and a gate requiring the filter to have fired would
  // be requiring this seed to have a near miss, which is a claim about the map
  // and not about the filter. The direct question is the honest one: at a
  // portal's own front door, does the predicate say no?
  const portal = view.objectives.portals[0].position
  const rejectedBefore = view.waterRejected
  // Canonical coordinates with `copy: 0`, because `_waterClear` takes a DRAWN
  // position and subtracts `copy * WORLD_EXTENT` itself. Passing `copy: 1` with a
  // canonical point asks the question 448 m from where the portal is, and the
  // first version of this check did exactly that and reported that a puddle may
  // stand in a portal doorway.
  assert.equal(view._waterClear(portal.x, portal.z, 0), false, 'the water exclusion lets a puddle stand in a portal doorway')
  // The same doorway in a WRAPPED copy, which is the half that is easy to get
  // wrong: the exclusion has to fold, or it silently exists in one ninth of the
  // world and every other copy is unwetted.
  assert.equal(view._waterClear(portal.x + hood.WORLD_EXTENT, portal.z + hood.WORLD_EXTENT, 1), false, 'the exclusion does not fold, so a portal in copy 1 has water in front of it')
  assert.ok(view.waterRejected > rejectedBefore, 'the exclusion refused a doorway without recording it, so nothing can tell the filter ran')
  // ...and it says yes a long way out, or it is a filter that refuses everything.
  assert.equal(view._waterClear(portal.x + 40, portal.z, 0), true, 'the water exclusion refuses a spot 40 m from a portal, so it is refusing everything')
  // THE TILE TILES, measured off the shimmer's OWN PIXELS rather than off the
  // source. `RepeatWrapping` on a scrolled map is the ENABLER of a seam, not its
  // prevention: a texture whose value at u=0 does not equal its value at u=1
  // draws a hard line at that boundary, and `CANAL_SHIMMER_TILES` boundaries are
  // 3.71 m apart going down a 26 m channel at 0.06 m/s. The pass shipped sine
  // bands at 2.3 and 4.1 cycles and a swell at 1.7 — non-integers, so the sines
  // do not close — and every other gate in the suite passed, because a wrap mode
  // and a repeat count say nothing about whether the image between them is
  // continuous.
  //
  // This is the check that could not be written before the 2D stub kept its
  // `putImageData` payload: "does the generated texture meet itself" is a
  // property of the image and of nothing else, and reading it off the source
  // regexes that produced the pixels would be asking the generator whether it
  // agrees with itself.
  // three.js keeps the canvas on `map.image` and the canvas is the stub, so the
  // pixels the generator handed to `putImageData` are read back off
  // `map.image.pixels` — the image itself, not a re-derivation of it.
  const image = map.image && map.image.pixels
  assert.ok(image && image.data, 'the shimmer canvas kept no pixels, so its tile cannot be measured')
  assert.ok(image.width > 1 && image.height > 1, `the shimmer is ${image.width}x${image.height}, which is not a tile`)
  const red = (x, y) => image.data[(y * image.width + x) * 4]
  const size = image.width
  // A SEAM IS THE WRAP, RELATIVE TO THE TEXTURE'S OWN STEEPEST STEP — and the
  // word "relative" is the whole of this gate.
  //
  // The obvious assertion is that the first and last texels of an axis are
  // equal, and it is wrong twice over. The generated buffer samples `u = x/size`
  // for `x` in `[0, size)`, so the last texel sits at 0.984 and wraps to 0.0
  // across a one-texel gap: even a perfectly periodic function lands with a step
  // there, and a bound tight enough to reject that step also rejects the correct
  // texture. The first version of this check used `vSeam <= 3 && uSeam <= 3` and
  // failed the FIXED shimmer at 3 and 6 — a gate that could not be satisfied by
  // any seamless sine, which is a gate that reports the world is broken.
  //
  // The honest question is whether the wrap is distinguishable from the texture
  // it is cut out of. A gradient that steps by `n` between neighbouring texels
  // has no seam at its edge if the wrap steps by no more than `n`: the eye
  // cannot see a discontinuity it cannot see the inside of. So the bound is the
  // steepest ADJACENT step already inside the tile, in the same direction, and
  // the pass as shipped — measured at `SURFACE_SEEDS.water` — wraps its U axis
  // by 70/255 against an interior maximum of 7, and its V axis by 38 against
  // 20: a discontinuity an order of magnitude steeper than anything the texture
  // does on its own, which is precisely what a seam looks like.
  let maxInnerU = 0
  let maxInnerV = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size - 1; x += 1) maxInnerU = Math.max(maxInnerU, Math.abs(red(x + 1, y) - red(x, y)))
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size; x += 1) maxInnerV = Math.max(maxInnerV, Math.abs(red(x, y + 1) - red(x, y)))
  }
  let wrapU = 0
  let wrapV = 0
  for (let y = 0; y < size; y += 1) wrapU = Math.max(wrapU, Math.abs(red(0, y) - red(size - 1, y)))
  for (let x = 0; x < size; x += 1) wrapV = Math.max(wrapV, Math.abs(red(x, 0) - red(x, size - 1)))
  assert.ok(
    wrapU <= maxInnerU && wrapV <= maxInnerV,
    `the shimmer does not tile: wrapping its U axis steps ${wrapU}/255 where the texture's own steepest step is ${maxInnerU}/255, and its V axis steps ${wrapV}/255 against ${maxInnerV}/255, so a scrolled RepeatWrapping map draws a hard seam once per tile`,
  )
  // ...and it is not a FLAT tile either, which is the other half of the same
  // bound: a texture that is one value everywhere also has a zero wrap step, and
  // a canal whose surface does not vary along its length is a painted line. The
  // crest-to-trough spread has to be a real fraction of the range.
  let low = 255
  let high = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = red(x, y)
      if (value < low) low = value
      if (value > high) high = value
    }
  }
  assert.ok(high - low > 40, `the shimmer spans only ${high - low}/255 from crest to trough, so there is no pattern to scroll`)
  console.log(`\n  pass-8 canal: ${long.toFixed(1)} m long, crossing ${roadDistance(water[1].z).toFixed(1)} m from the centreline, shimmer ${after.toFixed(4)} after 4 s, tile wraps u${wrapU}/${maxInnerU} v${wrapV}/${maxInnerV} over ${high - low}/255 of crest-to-trough`)
})

check('the portal exclusion is CALLED, and not merely correct when asked', () => {
  // The check above proves `_waterClear(portalX, portalZ, copy)` is FALSE at a
  // portal's own front door. It says nothing about whether `_addStreak` ever ASKS
  // — and the difference is a line of code, not a bug you can see. Deleting
  // `if (!this._waterClear(x, z, copy)) continue` from `_addStreak` and running
  // the suite leaves 76/76 green, because a predicate that is only ever tested
  // directly has no call site left to remove. That mutation was found by running
  // it, and this check is the one that catches it.
  //
  // The method is a PLANT, in the same shape as the pass-7 furniture probe: move
  // a real portal onto a real piece of water, rebuild, and require that exact
  // piece to be gone. It is the only form of this assertion that is independent
  // of the seed — `waterRejected` is 0 on this seed by design, and a check that
  // counted rejections would be a claim about the map rather than about the
  // filter, which is the mistake the comment above this one is warning about.
  game.restart()
  run(game, 0.5)
  const view = game.streetView
  const POOLS = ['puddles', 'wetSheen', 'streaks', 'canalWater', 'canalLips']
  const rebuild = () => {
    for (const name of POOLS) view.pools[name].clear()
    view._buildWater()
  }
  const anchor = view.objectives.portals[0]
  // Three numbers and not `.clone()`: `anchor.position` is a plain `{x, y, z}`
  // record, not a `THREE.Vector3`, so the Vector3 method is not there to call.
  // Saving the components also survives whatever type it is.
  const saved = { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z }

  const place = (x, y, z) => { anchor.position.x = x; anchor.position.y = y; anchor.position.z = z }
  const restoreAnchor = () => place(saved.x, saved.y, saved.z)

  for (const kind of ['streak', 'puddle']) {
    // BACK TO THE UNPLANTED WORLD before every iteration, and this is not tidiness.
    // The first version picked its two victims in sequence from a log that the
    // first plant had already edited, and the count assertion came back 447
    // before and 447 after — because planting the portal back near the street
    // RESTORED the water the streak plant had removed while excluding a
    // different set. The specific-victim assertion still passed, so the check
    // would have shipped with a count gate that measures the difference between
    // two plants rather than the cost of one. Each iteration is now its own
    // baseline, and `baseline` is that world.
    restoreAnchor()
    rebuild()
    const baseline = view.waterLog.length
    const victim = view.waterLog.find((entry) => entry.kind === kind)
    assert.ok(victim, `this world placed no ${kind} to plant a portal on, so this check would pass vacuously`)
    // The log records the DRAWN position and the copy, and `_waterClear` folds by
    // `copy * WORLD_EXTENT` back to canonical — so the portal has to be planted
    // at the canonical point, not at the drawn one. Planting at `victim.x` in
    // copy 2 would ask the question 896 m from where the filter looks.
    place(victim.x - victim.copy * hood.WORLD_EXTENT, victim.y ?? 0, victim.z - victim.copy * hood.WORLD_EXTENT)
    rebuild()
    const survivor = view.waterLog.find(
      (entry) => entry.kind === kind && Math.abs(entry.x - victim.x) < 1e-6 && Math.abs(entry.z - victim.z) < 1e-6,
    )
    assert.equal(survivor, undefined, `a portal planted on a ${kind} at (${victim.x.toFixed(1)}, ${victim.z.toFixed(1)}) left that ${kind} standing in its own doorway`)
    assert.ok(view.waterLog.length < baseline, `planting a portal on a ${kind} removed nothing: ${baseline} pieces before, ${view.waterLog.length} after`)
    // ...and the halo went with the puddle, because the halo is written in the
    // same call. A plant that removed the water and left a damp disc on the
    // carriageway would be the pass-8 version of the artefact the halo exists to
    // avoid, and the count below is how that would be caught.
    if (kind === 'puddle') {
      assert.equal(view.pools.wetSheen.used, view.pools.puddles.used, `${view.pools.wetSheen.used} halos for ${view.pools.puddles.used} puddles after a plant, so the halos and the water are out of step`)
    }
  }

  // RESTORE, and prove the restore worked rather than assuming it: a check that
  // left a portal on top of a puddle would corrupt every check after it, and the
  // count is the only thing that would say so.
  restoreAnchor()
  rebuild()
  const streaks = view.waterLog.filter((entry) => entry.kind === 'streak').length
  assert.equal(streaks, view.lampPositions.length * 3, `after restoring the portal the world has ${streaks} streaks, so the plant was not undone and every later check is reading a different world`)
  for (const name of POOLS) view.pools[name].commit()
  console.log(`\n  pass-8 portal plant: both water families re-filtered, ${streaks} streaks restored`)
})


// ---------------------------------------------------------------------------
// iteration 2, pass 9 — the sky in the BUILT world
//
// These are the checks `verify.mjs` could not write. Everything above is a
// property of a line of source; everything below is a property of the scene that
// line produced, measured off the live Three.js objects after the world has been
// constructed, stepped and torn down.
//
// The headline is the SECOND one. The brief asked for "an explicit
// distance/position check" proving the horizon silhouettes cannot block a portal
// or shed sightline, and the check below answers it in the only form that can be
// true for every player position: the ring is CAMERA-RELATIVE at a constant
// radius, so the distance from the eye to the nearest silhouette is a constant
// that no walk can change. A filter would have to be re-applied to every future
// placement; a constant radius cannot be forgotten.
// ---------------------------------------------------------------------------

/** The pass's built objects, and the pool-free counts the harness reads. */
const SKY_MESHES = ['skyMoon', 'skyHorizon', 'skyHazeBand0', 'skyHazeBand1', 'skyHazeBand2', 'skyAsh']

/**
 * `skyNumber` — a named constant out of `skyView.js`.
 *
 * The same reason `waterNumber` exists: the check and the thing it checks cannot
 * then disagree about what the number is, and the values are READ rather than
 * re-derived, because the assertion below is that the constant and the BUILT ring
 * agree. A helper that re-derived the radius from the geometry would be checking
 * the geometry against itself.
 *
 * This file needs a source string where the pure harness does not, which is worth
 * noting: it is not because the world harness cannot read a material (it can, and
 * the budget check below does), but because the ring's radius has no material to
 * read it from. The geometry is forty-two boxes and the radius is the number
 * their positions were computed from; the only way to compare the two is to hold
 * the claim on one side and the build on the other.
 *
 * @param {string} name the constant's name, without `const`
 * @returns {number} its value
 */
function skyNumber(name) {
  const found = new RegExp(`const ${name} = (-?[\\d.]+)`).exec(SKY_VIEW_SOURCE)
  assert.ok(found, `${name} is not a named constant any more, so this check is reading nothing`)
  return Number(found[1])
}

/** Every mesh under the sky root, flattened. */
function skyObjects(sky) {
  const out = []
  sky.root.traverse((object) => {
    if (object.isMesh || object.isPoints) out.push(object)
  })
  return out
}

/**
 * `HORIZON_POSITION_TOLERANCE` — how far off the 232 m ring a silhouette may sit,
 * in metres, and WHY THE NUMBER IS WHAT IT IS.
 *
 * PASS 17, and this tolerance is not a loosened threshold — it is a replacement
 * for one that was measuring the wrong instrument.
 *
 * BEFORE: `worst < 1e-6`, which was correct FOR THE OLD REPRESENTATION and is
 * meaningless for this one. The ring was forty-two `THREE.Mesh` children, each
 * holding a float64 `Vector3`, and `getWorldPosition` read it back exactly. The
 * bound was 1 µm on a 232 m ring, and it passed at 0.0.
 *
 * AFTER: the ring is one `InstancedMesh`, and `instanceMatrix` is a
 * `THREE.InstancedBufferAttribute` over a **`Float32Array`**. Every position this
 * check reads has been through a float32 round trip, so the floor on the
 * measurement is set by float32's resolution and not by anything in the code:
 *
 *     232 m * 2^-24  =  1.4e-5 m   (half a ULP at 232 in single precision)
 *
 * The first run of the new check reported `worst = 2.6e-6` and printed
 * `0.0000 m off the ring` — the error is real, it is four micrometres, and it is
 * entirely float32 quantisation. Measured, not assumed: the recovered `x` came
 * back as `38.1832733154296875`, which is a value representable in single
 * precision, and the float64 construction is `38.18327562618308`.
 *
 * The ceiling is `1e-3` — one millimetre — and the reason it is a millimetre and
 * not `1.4e-5` is that the bound has to survive a camera position far from the
 * origin as well as the quantisation: the check folds by adding and subtracting
 * the camera's own coordinate, and at a wrapped position of ±448 m that
 * subtraction gives up about a further `5.7e-14`. A millimetre is four hundred
 * times the quantisation, and it is still **0.004 of one pixel** at the ring —
 * at 232 m under 72° of FOV across 1280 px, one pixel is about 0.26 m. The
 * property being tested is that no silhouette can stand in front of a portal, and
 * four micrometres cannot do that; a value that could would be metres.
 *
 * @type {number}
 */
const HORIZON_POSITION_TOLERANCE = 1e-3

/**
 * `horizonBoxes` — the ring's 42 boxes, as WORLD positions and world-space extents.
 *
 * PASS 17. The ring used to be 42 `THREE.Mesh` children of `sky.horizon` and these
 * three checks walked `horizon.children` calling `getWorldPosition` on each. It is
 * now ONE `InstancedMesh` with 42 instance matrices, so there is one object and
 * forty-two transforms to decompose.
 *
 * The helper is here rather than inline in each check because three separate gates
 * need the same answer and the whole point of this pass is that a duplicated
 * traversal is a second place for the two representations to drift. It reads the
 * INSTANCE MATRICES, which is strictly better than what it replaced: the old code
 * asked each child mesh where it was, and this asks the ring what it is about to
 * draw. A builder that placed a mesh correctly and then failed to write the matrix
 * passes the old check and fails this one.
 *
 * @param {object} sky a `SkyView`
 * @returns {{x: number, y: number, z: number, w: number, h: number, d: number}[]}
 */
function horizonBoxes(sky) {
  const ring = sky.horizonMesh
  assert.ok(ring && ring.isInstancedMesh, 'the horizon is not an InstancedMesh, so horizonBoxes has nothing to read')
  assert.equal(ring.count, sky.horizonCount, `the ring draws ${ring.count} instances and claims ${sky.horizonCount} boxes`)
  const out = []
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  // `horizon` is a child of `root`, which sits on the camera in x and z and at y 0,
  // so the world matrix of the ring is the product of the two. Read it rather than
  // assuming it: the wrap-immunity claim in the sibling check is that `root` does
  // NOT translate by whole street periods, and this is where that is felt.
  //
  // AND THE UPDATE, which is not an optimisation — it is what the old
  // `getWorldPosition` call did for free. `Object3D.getWorldPosition` calls
  // `updateWorldMatrix(true, false)` on the way in, and this harness's fake
  // renderer never calls `updateMatrixWorld` on anything, so without this line the
  // parent is whatever it was at the last time something else refreshed it. The
  // first run of the new helper reported a silhouette at 452 m on a 232 m ring
  // after the check teleported the player: the ring's own matrices were fresh and
  // the camera-relative parent was not.
  sky.root.updateMatrixWorld(true)
  const parent = new THREE.Matrix4().copy(sky.horizon.matrixWorld)
  for (let slot = 0; slot < ring.count; slot += 1) {
    ring.getMatrixAt(slot, matrix)
    matrix.premultiply(parent)
    matrix.decompose(position, quaternion, scale)
    out.push({ x: position.x, y: position.y, z: position.z, w: scale.x, h: scale.y, d: scale.z })
  }
  return out
}

check('the sky is built, camera-relative, and never inside the wrapped street group', () => {
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  assert.ok(sky, 'the world has no skyView, so this pass is not in the build')
  assert.ok(sky.root, 'the sky has no root')
  assert.equal(sky.disposed, false, 'the sky is already disposed after half a second of running')
  // It is a SIBLING of the street, not a child. This is the wrap immunity stated
  // in the module header and it is the one structural claim about the scene
  // graph: `streetView.group` translates by whole 448 m periods as the player
  // walks, so a sky inside it would swim across the frame every time the wrap
  // fired. Reading it off the parent chain is the only way to be sure, and a
  // comment is not.
  assert.equal(sky.root.parent, game.scene, 'the sky root is not a direct child of the scene, so it may be inside the wrapped street group')
  assert.notEqual(
    sky.root.parent,
    game.streetView.group,
    'the sky is inside the street group, which translates by whole 448 m periods — the horizon would swim',
  )
  assert.notEqual(sky.root.parent, game.creatureView.root, 'the sky is inside the creature view, which is disposed on banish')
  // All six families exist, are named, and are in the scene. Counted rather than
  // pattern-matched, because a family that renders nothing still has a name.
  // The five families, read as a NAME over everything under the root — meshes,
  // points AND groups. `skyHorizon` is a group, not a mesh, and a check that only
  // walked meshes would have reported the ring as missing while the ring was
  // standing right there. The distinction matters: the group is what holds the
  // forty-two parts, so "the horizon is not in the scene" and "the horizon is not
  // a mesh" are different failures with different fixes.
  const names = new Set()
  sky.root.traverse((object) => {
    if (object.name) names.add(object.name)
  })
  for (const name of SKY_MESHES) {
    assert.ok(names.has(name), `the sky family ${name} is not in the built scene`)
  }
  assert.equal(sky.root.name, 'sky', 'the sky root is not named, so it cannot be told from any other group in the scene')
  // The root follows the camera in X and Z, and is PINNED to y = 0. Following Y
  // would put a skyline at eye level and drop the ash through the road, so this
  // asserts the exact triple rather than "close to the camera".
  const camera = game.camera.position
  assert.ok(Math.abs(sky.root.position.x - camera.x) < 1e-6, `the sky root is ${(sky.root.position.x - camera.x).toFixed(3)} m from the camera in x`)
  assert.ok(Math.abs(sky.root.position.z - camera.z) < 1e-6, `the sky root is ${(sky.root.position.z - camera.z).toFixed(3)} m from the camera in z`)
  assert.equal(sky.root.position.y, 0, `the sky root is at y = ${sky.root.position.y}, so the horizon is at eye level and the ash is underground`)
  // And the whole thing moves WITH the camera. This is the property that makes
  // the ring a horizon rather than a landmark, and it is measured by walking.
  const before = { x: sky.root.position.x, z: sky.root.position.z }
  game.player.teleport(camera.x + 37.5, camera.z - 21.25)
  run(game, 0.2)
  assert.ok(
    Math.abs(game.skyView.root.position.x - game.camera.position.x) < 1e-6
      && Math.abs(sky.root.position.x - before.x) > 30,
    'the sky root did not follow the camera when the player walked 43 m, so the horizon is world-anchored and will wrap',
  )
  console.log(`\n  pass-9 sky: ${skyObjects(sky).length} meshes under a root that is a scene sibling, following the camera in x/z at y = 0`)
})

check('the horizon ring is a constant radius from the eye, and clear of every portal and shed', () => {
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  const radius = skyNumber('HORIZON_RADIUS')

  // THE EXPLICIT DISTANCE/POSITION CHECK THE BRIEF ASKED FOR, and it is measured
  // off the built matrices rather than asserted from the source: every silhouette
  // sits at EXACTLY `HORIZON_RADIUS` from the camera, in every direction.
  //
  // The reason this is the right form of the guarantee is worth stating, because
  // the obvious alternative is wrong. A world-anchored ring has to be checked
  // against every lot, every shed and every portal anchor at every position the
  // player can reach — and the player can reach 448 m of world, so that check is
  // 448 m of continuous cases rather than a constant. The camera-relative ring
  // collapses the whole question to one number, and the number cannot change
  // because nothing in the ring reads the player's position.
  // PASS 17. `horizonBoxes(sky)` instead of `sky.horizon.children`: one
  // `InstancedMesh` with 42 instance matrices where there were 42 child meshes, and
  // the boxes are read out of the matrices the renderer will use. See the helper for
  // why that is a stronger read than the one it replaced.
  sky.root.updateMatrixWorld(true)
  const ring = horizonBoxes(sky)
  assert.ok(ring.length >= 14, `the horizon has ${ring.length} parts, so the ring is not built`)
  let worst = 0
  for (const box of ring) {
    // The part is placed under `horizon`, which is under `root`, which is at the
    // camera. The world position is the sum, and the distance from the eye is the
    // radius by construction — so this measures the construction rather than
    // trusting it.
    const eye = new THREE.Vector3(game.camera.position.x, 0, game.camera.position.z)
    const distance = Math.hypot(box.x - eye.x, box.z - eye.z)
    worst = Math.max(worst, Math.abs(distance - radius))
  }
  assert.ok(
    worst < HORIZON_POSITION_TOLERANCE,
    `a horizon silhouette is ${worst.toExponential(3)} m off the ${radius} m ring, over the ${HORIZON_POSITION_TOLERANCE} m the instanced representation can resolve, so the ring is not a constant radius and the sightline guarantee is void`,
  )

  // ...and it is the same constant from EVERY position, which is the guarantee.
  // Four corners of the canonical window plus the spawn, because the wrap makes
  // "four corners" a statement about the torus rather than about one block.
  for (const [x, z] of [[-190, 254], [-190, -190], [254, 254], [254, -190], [0, 0]]) {
    game.player.teleport(x, z)
    run(game, 0.2)
    const moved = game.skyView
    const eye = { x: game.camera.position.x, z: game.camera.position.z }
    for (const box of horizonBoxes(moved)) {
      const distance = Math.hypot(box.x - eye.x, box.z - eye.z)
      assert.ok(
        Math.abs(distance - radius) < HORIZON_POSITION_TOLERANCE,
        `at (${x}, ${z}) a silhouette is ${distance.toFixed(4)} m from the eye rather than ${radius} m`,
      )
    }
  }

  // THE PORTAL SIGHTLINE, and this is where the first version of the check was
  // wrong in a way worth recording. It asserted that every portal anchor is nearer
  // than the ring, and it failed at 350.8 m — which is NOT a defect in the sky.
  // Across a 448 m torus a portal in the next copy is genuinely 350 m from the
  // player, the far plane is 260 m, and the fog at dusk 0 is 50% opaque at 111 m:
  // that portal is a shape nobody can see through a 260 m clip, let alone one
  // standing 232 m in front of it. The assertion was a real property with an
  // unjustified scope, and the honest version is the one the brief asked for.
  //
  // The claim is about the DISTANCES THE PLAYER CAN ACTUALLY SEE, which the fog
  // defines, and there are exactly two of them: the §16.5.5 stand-off a capture
  // photographs a gate from, and the creature's own §6.1 sighting range. A
  // silhouette standing between the eye and either of those is the only failure
  // that matters, and both are far inside the ring.
  const fogHalf = rules.fogVisibility(rules.fogDensityForDusk(0))
  const anchors = game.streetView.portals.map((entry) => game.streetView.worldOf(entry.position))
  const nearestPortal = Math.min(
    ...anchors.map((anchor) => Math.hypot(anchor.x - game.camera.position.x, anchor.z - game.camera.position.z)),
  )
  assert.ok(
    radius > fogHalf * 2,
    `the ring is at ${radius} m and the world is half-fogged at ${fogHalf.toFixed(0)} m, so a silhouette can stand in front of geometry the player is still able to see`,
  )
  // The §16.5.5 stand-off itself: 4.5 m on the structure's own facing, which is
  // `PORTAL_GATE_OFFSET`'s neighbourhood. The check is that the ring is two orders
  // of magnitude beyond it, so no silhouette is ever between that camera and its
  // subject — and the render order guarantees the rest.
  const standOff = 4.5
  assert.ok(
    radius > standOff * 20,
    `the ring is at ${radius} m and the §16.5.5 gate stand-off is ${standOff} m, so a silhouette could be in the pupil frame`,
  )
  // And the far plane, which is the other hard bound: anything the renderer
  // cannot draw cannot be obscured by anything the renderer does draw.
  assert.ok(radius < game.camera.far, `the ring is at ${radius} m and the far plane is ${game.camera.far} m`)
  // The nearest portal, reported because a reader of this log will want to know
  // the ring's margin against the thing it is protecting. The far ones are not a
  // concern and are deliberately not asserted on.
  assert.ok(
    nearestPortal > 0,
    `a portal anchor is on top of the camera at (${game.camera.position.x.toFixed(1)}, ${game.camera.position.z.toFixed(1)}), so the stand-off is broken independently of the sky`,
  )

  // And the ring is outside the street grid's own reach, with margin, read from
  // the neighbourhood's constants so a change to `SETBACK` moves the bound.
  const built = ((hood.GRID - 1) / 2) * hood.BLOCK + hood.SETBACK + hood.LOT_DEPTH
  assert.ok(
    radius > built + 10,
    `the ring is at ${radius} m and the street builds to ${built.toFixed(0)} m, so a silhouette stands inside the grid`,
  )
  // The far plane holds it, read off the camera rather than restated.
  assert.ok(
    radius < game.camera.far,
    `the ring is at ${radius} m and the camera's far plane is ${game.camera.far} m, so the horizon is clipped away`,
  )
  // And the occluder list is untouched: the ring contributes NOTHING to what
  // `creature.js`'s §6.3 sightline walks. This is the second, independent line of
  // defence, and it is checked by PLANTING rather than by reading a count — see
  // the plant check below.
  const before = game.streetView.occluders().length
  const kinds = new Set(game.streetView.occluders().map((entry) => entry.kind))
  assert.equal(kinds.has('sky') || kinds.has('horizon'), false, 'a horizon silhouette is in the occluder list, so it can hide the creature')
  assert.equal(before, game.streetView.occluders().length, 'building the sky changed the occluder list, so the ring is a world object after all')
  console.log(`\n  pass-9 horizon: ${ring.length} parts at a constant ${radius} m, ${(radius - built).toFixed(0)} m past the built world (${built.toFixed(0)} m), ${(game.camera.far - radius).toFixed(0)} m inside the far plane (${game.camera.far} m), nearest portal ${Math.max(...anchors.map((a) => Math.hypot(a.x - game.camera.position.x, a.z - game.camera.position.z))).toFixed(1)} m`)
})

check('the sky is layered by render order, and the moon is behind the bands that veil it', () => {
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  const world = game.scene
  // Read the orders off the BUILT objects, not off the source. A constant that is
  // declared and never applied to a mesh is the failure this catches, and it is
  // invisible in a screenshot because the sky still draws — just in the wrong
  // order, which for a moon means it stops being occluded by the overcast.
  const orderOf = (name) => {
    let found = null
    world.traverse((object) => {
      if (object.name === name) found = object.renderOrder
    })
    assert.notEqual(found, null, `${name} is not in the built scene, so its render order cannot be read`)
    return found
  }
  const moon = orderOf('skyMoon')
  const horizon = orderOf('skyHorizon')
  const bands = [0, 1, 2].map((index) => orderOf(`skyHazeBand${index}`))
  const ash = orderOf('skyAsh')

  // EVERY sky order is below the world's lowest. This is the structural safety
  // property and it is checked against the world's OWN value rather than a
  // restatement, so a future pass that reorders the street cannot quietly make
  // the sky the thing drawn on top.
  // The world's own floor, found by EXCLUDING the sky subtree properly. The first
  // version of this scan tested `sky.root.children.includes(object)`, which is one
  // level deep and let `skyHorizon` — a direct child of the root — count as world
  // geometry. The symptom was a sky order of -99 reported as "the world starts at
  // -99", which is a gate comparing the thing under test against itself. The
  // subtree is excluded by walking it, which is depth-independent.
  const inSky = new Set()
  sky.root.traverse((object) => inSky.add(object))
  let worldLowest = Infinity
  let worldSamples = 0
  world.traverse((object) => {
    if (inSky.has(object)) return
    if (object === world) return
    worldSamples += 1
    if (object.renderOrder < worldLowest) worldLowest = object.renderOrder
  })
  assert.ok(worldSamples > 100, `only ${worldSamples} objects outside the sky, so the world scan is not seeing the scene`);
  for (const [name, order] of [['moon', moon], ['horizon', horizon], ['ash', ash], ...bands.map((o, i) => [`band${i}`, o])]) {
    assert.ok(
      order < worldLowest,
      `the sky's ${name} is drawn at order ${order} and the world starts at ${worldLowest}, so the sky can appear in front of the street`,
    )
  }
  // The moon comes before the bands. This is not an occlusion claim — additive
  // blending is commutative, so no ordering of the sky's own elements can change
  // the frame. It is a SLOT claim, and the reason to make it is the one the next
  // assertion checks.
  assert.ok(moon < bands[0], `the moon is at ${moon} and the nearest band at ${bands[0]}, so the disc no longer has a slot of its own before the strata`)
  // EVERY ORDER IS DISTINCT. This is the real check, and it is here because the
  // first version of `skyView.js` computed the bands as `base - index`, which put
  // the third band on -100 — the MOON's slot. A tie is not an order: three.js
  // breaks a renderOrder tie by material id, which is an allocation artefact and
  // not a layering rule. The symptom was invisible and would have stayed
  // invisible, which is why it is a count rather than a comparison.
  const orders = [moon, horizon, ash, ...bands]
  assert.equal(
    new Set(orders).size,
    orders.length,
    `the sky's render orders are ${orders.join(', ')} — two of them share a slot, so their relative order is decided by material id`,
  )
  // The bands ascend near-to-far, i.e. the NEAR band takes the last-drawn slot.
  // The sign is the thing worth asserting: three.js draws the LOWER renderOrder
  // first, so the opposite sign would put the far band in front of the near one.
  assert.ok(
    bands[0] < bands[1] && bands[1] < bands[2],
    `the band orders are ${bands.join(', ')} — the near band is not drawn last, so the run is the wrong way round`,
  )
  // And the bands really are near-to-far, which is what the run encodes. Read off
  // the built positions rather than the table, so a reordered table fails here.
  const radii = sky.bands.map((entry) => Math.hypot(entry.mesh.position.x, entry.mesh.position.z))
  for (let index = 0; index + 1 < radii.length; index += 1) {
    assert.ok(radii[index] < radii[index + 1], `band ${index} is at ${radii[index].toFixed(1)} m and band ${index + 1} at ${radii[index + 1].toFixed(1)} m, so the draw order does not match the depth`)
  }
  console.log(`\n  pass-9 order: moon ${moon}, horizon ${horizon}, bands ${bands.join('/')}, ash ${ash}, world's lowest ${worldLowest}; band radii ${radii.map((r) => r.toFixed(0)).join('/')} m`)
})

check('the sky is a light rim and a light rim is all it is: the luma budget, measured on the built materials', () => {
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  // The budget `verify.mjs` computes arithmetically, measured here on the objects
  // that will actually be submitted. The two are the same claim read two ways, and
  // that is deliberate: the pure harness reads the palette and the peaks, and
  // this one reads the `THREE.Color` instances three.js will tone-map. A
  // disagreement between them is a bug in one of them.
  //
  // `lumaOf` encodes to sRGB first, which is the whole point — a `Color` holds
  // linear components, and taking a luminance straight off them reports 6 luma
  // for a fog `streetView.js` calls 43.
  // How the peak reaches the frame differs per family, and reading it wrong is
  // how this check first reported 127.9 luma against a budget of 75:
  //
  //  - the MOON keeps `skyMoon` as its colour and applies `MOON_PEAK` through
  //    `opacity`, so the contribution is `lumaOf(colour) * opacity`;
  //  - the BANDS bake their peak into the colour (`skyHaze` scaled by the band's
  //    own `peak`) and leave `opacity` at 1, so `lumaOf(colour)` is already the
  //    contribution and multiplying by anything double-counts it;
  //  - the ASH does the same.
  //
  // The bands' and the ash's material `opacity` is asserted to be 1 below, which
  // is what pins the distinction — otherwise a future pass that switches one of
  // them to `opacity` would silently halve its contribution here.
  // ...and the moon is the SAME case as the others, which the first version of
  // this check got wrong in the opposite direction. `opacity` scales the
  // fragment's ALPHA, and AdditiveBlending is `src.rgb * src.a + dst.rgb` — so the
  // added light is the LINEAR colour times `opacity`, encoded afterwards. Reading
  // it as `lumaOf(colour) * opacity` multiplies in sRGB space and reports 3.3
  // luma where the renderer produces 21.4, because sRGB encoding is steep near
  // black. All three families are now measured the same way, and the one place
  // they differ is that the moon uses `opacity` where the others bake the peak
  // into the colour — which is why `lumaOf(colour.clone().multiplyScalar(peak))`
  // is the right expression for all three.
  const moonMaterial = sky.moonMaterial()
  const moonLuma = lumaOf(moonMaterial.color.clone().multiplyScalar(moonMaterial.opacity))
  const bandLumas = sky.bandMaterials().map((material) => lumaOf(material.color))
  const ashLuma = lumaOf(sky.ashMaterial().color)
  const total = moonLuma + bandLumas.reduce((a, b) => a + b, 0) + ashLuma
  for (const material of [...sky.bandMaterials(), sky.ashMaterial()]) {
    assert.equal(
      material.opacity,
      1,
      'a band or the ash applies its peak through `opacity` as well as through its colour, so its contribution is counted twice by this check and once by the renderer',
    )
  }

  const EYE_MIN = 150
  assert.ok(
    total < EYE_MIN * 0.5,
    `the built sky adds ${total.toFixed(1)} luma at worst, over half of EYE_MIN ${EYE_MIN} — png-luma's eye finder could resolve it as the creature`,
  )
  // The moon on its own, because the brief named it: visible, and dim.
  // "Barely-visible" and "not bright" are two bounds, and both are here. The
  // floor is 12: below that the disc is under the sky's own noise and the brief's
  // "pale disc" is a smudge nobody would ever describe as a moon.
  assert.ok(moonLuma > 12, `the moon is ${moonLuma.toFixed(1)} luma, so it is not visible and the brief's pale disc is a smudge`)
  assert.ok(moonLuma < 40, `the moon is ${moonLuma.toFixed(1)} luma, which is a light rather than a disc`)
  // And the three additive families really are additive, and the two distant ones
  // really are unfogged, read off the built materials.
  for (const material of [sky.moonMaterial(), sky.ashMaterial(), ...sky.bandMaterials()]) {
    assert.equal(material.blending, THREE.AdditiveBlending, 'a sky material is not additive, so it is painting over the sky rather than adding to it')
    assert.equal(material.depthWrite, false, 'a sky material writes depth, so it can occlude the world drawn after it')
  }
  assert.equal(sky.moonMaterial().fog, false, 'the moon is fogged, so at 236 m it is a 0.0003%-opacity disc')
  assert.equal(sky.horizonMaterial.fog, false, 'the horizon is fogged, so at 232 m the ring is invisible')
  assert.equal(sky.ashMaterial().fog, false, 'the ash is fogged, so an additive mote adds the whole fog colour to itself')
  for (const material of sky.bandMaterials()) {
    assert.equal(material.fog, true, 'a haze band is unfogged, so it does not thicken with the dusk and §3.7 loses a limb')
  }
  console.log(`\n  pass-9 budget: moon ${moonLuma.toFixed(1)} + bands ${bandLumas.map((l) => l.toFixed(1)).join('/')} + ash ${ashLuma.toFixed(1)} = ${total.toFixed(1)} luma, ${(total / EYE_MIN * 100).toFixed(0)}% of EYE_MIN`)
})

check('the sky is deterministic: the same time twice gives the same sky', () => {
  // The contract `skyView.js`'s header states, exercised. Pass 8's shimmer is the
  // precedent: an accumulator would satisfy every screenshot and fail this,
  // because the sum depends on the frame history rather than on the clock.
  //
  // TWO ROUTES TO THE SAME TIME, which is the part that matters. A single route
  // would be satisfied by an accumulator that happened to agree, and the two
  // routes below differ by 2 extra frames: 62 x (1/60) and 60 x (1/60) + 2 x
  // (1/120), both landing on 1.0333 s. An accumulator carries the extra pair of
  // steps' residue; a pure function of `_time` does not.
  const snapshot = () => {
    const sky = game.skyView
    return {
      root: [sky.root.position.x, sky.root.position.y, sky.root.position.z],
      moon: [sky.moon.position.x, sky.moon.position.y, sky.moon.position.z, sky.moon.material.opacity],
      bands: sky.bands.map((entry) => [entry.mesh.position.x, entry.mesh.position.z]),
      ash: Array.from(sky.ashPositions),
    }
  }

  // The two routes have to reach the same `_time` BIT-IDENTICALLY, and the first
  // version of this check did not: 62 additions of 1/60 and 60 additions of 1/60
  // plus 2 of 1/120 are both 1.0333... in exact arithmetic, but `_time` is a
  // running float sum and the two sums differ in the last bits. The sky is a pure
  // function of `_time`, so the check was comparing two different values of it and
  // reporting the (correct) purity as drift.
  //
  // The fix is to make the SECOND route start from the first route's own state
  // and step back to the same clock: snapshot at some `t`, run on, then rewind
  // `_time` to exactly `t` and take a second snapshot. Any dependence on frame
  // history shows up as a difference, and the value under test is the one the
  // module's contract actually names.
  game.restart()
  run(game, 62 * (1 / 60))
  const first = snapshot()
  const at = game.skyView._time

  run(game, 45)
  assert.notEqual(game.skyView._time, at, 'the clock did not advance, so the rewind below is a no-op and proves nothing')
  // Rewind the clock alone, then step one frame of zero: the ash must come back
  // exactly. A history-dependent implementation cannot do this, because the
  // positions it accumulated on the way out are still in the buffer.
  game.skyView._time = at
  game.skyView.update(0)
  const second = snapshot()

  // The ash is the interesting one: ninety positions, three floats each, and the
  // only claim in the pass that a screenshot cannot make at all.
  assert.deepEqual(
    second.ash,
    first.ash,
    'the ash drifted between two runs that reached the same time, so it is a function of frame history rather than of the clock',
  )
  assert.deepEqual(second.bands, first.bands, 'the haze bands drifted between two runs at the same time')
  assert.deepEqual(second.moon, first.moon, 'the moon moved between two runs at the same time')
  assert.deepEqual(second.root, first.root, 'the sky root moved between two runs at the same time')
  // ...and the ash is actually MOVING, or all of the above is the trivial claim
  // that a frozen sky is a reproducible one. Measured ACROSS TIME, which is the
  // only way to measure it now that both snapshots are the same instant.
  const before = Array.from(game.skyView.ashPositions)
  run(game, 3)
  const after = Array.from(game.skyView.ashPositions)
  let drift = 0
  for (let index = 0; index < before.length; index += 1) {
    if (Math.abs(before[index] - after[index]) > 1e-6) drift += 1
  }
  assert.ok(drift > before.length * 0.5, `only ${drift} of ${before.length} mote coordinates changed in three seconds, so the ash is not drifting`)
  console.log(`\n  pass-9 determinism: ${first.ash.length / 3} motes bit-identical after the clock was advanced 3 s and rewound to t = ${at.toFixed(4)} s, ${drift} coordinates moved over the 3 s it was away`)
})

check('the horizon is a hazed silhouette: dark against the live sky, and varied in profile', () => {
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  const material = sky.horizonMaterial
  const shapeLuma = lumaOf(material.color)
  const skyLuma = lumaOf(game.scene.background)
  const fogLuma = lumaOf(game.scene.fog.color)

  // §12.1's silhouette rule, measured on the BUILT material against the live
  // sky rather than against the palette: the ring has to be a dark shape in
  // front of a lighter haze, or it is not a skyline. This is the same rule
  // `creature.js` obeys and the reason its body is near-black.
  assert.ok(
    shapeLuma < skyLuma,
    `the hazed silhouette is luma ${shapeLuma.toFixed(1)} and the sky is ${skyLuma.toFixed(1)}, so the ring is lighter than the air and reads as a stain`,
  )
  // And enough separation to actually read. A ring at 95% of the sky's luma is a
  // ring nobody can resolve, which is a different failure with the same cause.
  assert.ok(
    shapeLuma < skyLuma * 0.85,
    `the silhouette is luma ${shapeLuma.toFixed(1)} against a ${skyLuma.toFixed(1)} sky — not enough separation to read as a skyline`,
  )
  // It is hazed rather than black, and the check is that it is measurably LIGHTER
  // than its own palette entry. `horizonShape` is luma 29.7 and the sky stop is
  // 89.6, so an unhazed ring would be at 29.7 and a hazed one between.
  const raw = lumaOf(new THREE.Color(0x231d16))
  assert.ok(
    shapeLuma > raw,
    `the silhouette is luma ${shapeLuma.toFixed(1)}, which is at or below its unhazed palette value of ${raw.toFixed(1)} — the aerial-perspective mix is not being applied`,
  )
  assert.ok(shapeLuma < skyLuma, 'and it must still be under the sky')

  // PROFILE, and this is the one property of the ring that is about SHAPE. Three
  // kinds, and a ring of one kind is a fence. The check counts the KINDS off
  // `skyView`'s own record of what it built rather than reading the shape table,
  // because a kind that is named in `HORIZON_SHAPES` and never built is the exact
  // defect: the first version of `_horizonParts` had no `crane` branch at all and
  // let it fall through, which rendered correctly until a fourth kind arrived.
  //
  // PASS 17. The kinds used to be counted off `mesh.name.replace('skyHorizon_', '')`
  // over `horizon.children` — forty-two names, one per box. The ring is one
  // `InstancedMesh` with one name now, so the record has moved to
  // `sky.horizonParts`, which is the same list the writer loop consumed: one entry
  // per instance, in the same order, carrying the `kind` it was built for. That is
  // a stronger read than the names were — a box whose matrix was written from the
  // wrong part would have carried the wrong name too, and now carries the wrong
  // record, and both are checked against the count below.
  const kinds = new Map()
  for (const part of sky.horizonParts) {
    kinds.set(part.kind, (kinds.get(part.kind) ?? 0) + 1)
  }
  assert.deepEqual(
    [...kinds.keys()].sort(),
    ['crane', 'mast', 'tower'],
    `the ring carries kinds ${[...kinds.keys()].join(', ')} — the brief asked for water towers, radio masts and cranes`,
  )
  for (const [kind, count] of kinds) {
    assert.ok(count >= 4, `only ${count} ${kind} parts on a fourteen-silhouette ring, so one quadrant has none`)
  }
  // Every silhouette is THREE boxes, so 14 x 3 = 42, and the record has one entry
  // per instance rather than per child mesh. The two counts have to agree or the
  // record and the draw have drifted apart — which is the only way a per-instance
  // representation can be wrong while still looking right.
  assert.equal(sky.horizonParts.length, sky.horizonCount, 'horizonParts does not match horizonCount')
  assert.equal(sky.horizonCount, [...kinds.values()].reduce((a, b) => a + b, 0), 'horizonCount does not match the parts actually recorded')
  // The parts differ in SIZE, which is the variety claim: fourteen identical
  // stamps read as generated, and the per-instance scale is what stops that.
  //
  // PASS 17. This used to read `mesh.geometry.parameters.height` — the height of
  // the CACHED box, which pass 9 quantised to a 2 m grid, so the numbers it
  // compared were the cache's and not the world's. It now reads the DECOMPOSED
  // instance scale, which is the box's actual world-space height. The unit box is
  // 1 m and the scale carries the part's own height, so `h` here is metres and the
  // ratio is the one the eye sees.
  const boxes = horizonBoxes(sky)
  const heights = boxes.map((box) => box.h)
  const tallest = Math.max(...heights)
  const shortest = Math.min(...heights)
  assert.ok(tallest / shortest > 1.5, `every part on the ring is between ${shortest.toFixed(1)} m and ${tallest.toFixed(1)} m, so the per-instance scale is not being applied`)
  // ...and the WIDTHS vary too, which the old check never asked because the cache
  // put a tower's tank and its stalk on the same key. A ring of same-height
  // different-width boxes is a fence with windows.
  const widths = boxes.map((box) => box.w)
  assert.ok(
    Math.max(...widths) / Math.min(...widths) > 1.5,
    `the ring's widths only run from ${Math.min(...widths).toFixed(1)} m to ${Math.max(...widths).toFixed(1)} m, so the parts are one shape at four sizes`,
  )
  // ...and every box is `HORIZON_DEPTH` deep, which is the one number the unit-box
  // substitution depends on and the one a reader of the new code cannot check by
  // looking at a `BoxGeometry` any more.
  const depths = new Set(boxes.map((box) => Number(box.d.toFixed(6))))
  assert.equal(depths.size, 1, `the ring's parts are ${depths.size} different depths, so the shared unit box is not the shared box the pass claimed`)

  // The cost, and pass 17's budget is the frame of reference. The whole pass is a
  // handful of draw calls plus one Points and about 500 triangles; the world draws
  // about a hundred. This is the check that says the sky is cheap, and it is a
  // TRIANGLE count because a draw-call count is `tools/capture.mjs --budget`'s job
  // and this harness has no renderer.
  let triangles = 0
  for (const mesh of skyObjects(sky)) {
    if (mesh.name === 'skyAsh') continue  // points, not triangles
    const geometry = mesh.geometry
    const per = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
    // PASS 17. An `InstancedMesh` draws `count` copies, so the ring's contribution
    // is 12 triangles times 42 instances and not 12. Before this pass the horizon
    // was forty-two plain meshes, which is why the same sum was correct then and
    // would have UNDER-counted the ring by 492 triangles — a gate that read low
    // because it could not see the change, which is the failure mode this whole
    // pass exists to remove.
    triangles += per * (mesh.isInstancedMesh ? mesh.count : 1)
  }
  assert.ok(triangles < 800, `the sky costs ${triangles} triangles, over the 800 this pass budgeted for a backdrop`)
  console.log(`\n  pass-9 silhouette: luma ${shapeLuma.toFixed(1)} (unhazed ${raw.toFixed(1)}) against a sky of ${skyLuma.toFixed(1)} and fog of ${fogLuma.toFixed(1)}; ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')} on ONE instanced box, ${triangles} triangles`)
})

check('the sky costs three draw calls and a point cloud, and teardown releases all of it', () => {
  // §15's definition of done, and pass 17's budget, together. The render order
  // check above reads the compositing; this reads the COST and the LIFETIME, and
  // the two are separate claims: a sky that renders correctly and leaks a
  // texture per mount is a bug that only shows up as a slow death.
  game.restart()
  run(game, 0.5)
  const sky = game.skyView
  const objects = skyObjects(sky)
  // One group, one instanced ring of 42 parts, one moon, three bands, one point
  // cloud. PASS 17: the ring used to be counted as `parts.length >= 42`, which was
  // true and was also the reason forty-two draw calls went unremarked for eight
  // passes — the check read a count of OBJECTS and called it a budget. It now
  // counts INSTANCES off the one mesh, and separately asserts that the mesh is
  // one object, which is the property the budget actually needs.
  const bands = objects.filter((mesh) => mesh.name.startsWith('skyHazeBand'))
  const rings = objects.filter((mesh) => mesh.name === 'skyHorizon_ring')
  const ash = objects.filter((mesh) => mesh.name === 'skyAsh')
  const moon = objects.filter((mesh) => mesh.name === 'skyMoon')
  assert.equal(bands.length, 3, `there are ${bands.length} haze bands, so the pass's own budget is wrong`)
  assert.equal(moon.length, 1, 'there is not exactly one moon')
  assert.equal(ash.length, 1, 'the ash is not a single point cloud')
  assert.equal(rings.length, 1, `the horizon is ${rings.length} objects, so the forty-two parts are not one instanced draw`)
  assert.equal(sky.horizonMesh.count, 42, `the ring draws ${sky.horizonMesh.count} instances, so it is not the fourteen three-part silhouettes the pass claims`)
  // ...and the whole sky, in draw calls, which is what the check's NAME has always
  // claimed and what it could not measure until the ring was instanced. One moon,
  // one ring, three bands, one point cloud: six objects, and a point cloud is a
  // call. `tools/capture.mjs --budget` reads the same number off a real driver.
  assert.equal(objects.length, 6, `the sky is ${objects.length} drawable objects, not the six this pass's own name claims`)
  // The bands share ONE geometry and ONE texture, which is the cheap claim: three
  // copies of a 64x64 canvas would be three uploads and three chances to
  // generate a different band, and the bands must match to read as one fog bank.
  assert.equal(new Set(bands.map((mesh) => mesh.geometry)).size, 1, 'the three haze bands do not share one geometry')
  assert.equal(new Set(bands.map((mesh) => mesh.material.map)).size, 1, 'the three haze bands do not share one texture')
  // The ring shares ONE material and ONE geometry, so the dusk retune is one write
  // and the whole backdrop is one buffer. Before pass 17 the second half was "about
  // a dozen geometries"; it is now exactly one, and the check says so.
  assert.equal(new Set(rings.map((mesh) => mesh.material)).size, 1, 'the horizon ring does not share one material')
  assert.equal(new Set(rings.map((mesh) => mesh.geometry)).size, 1, 'the horizon ring is not one geometry')

  // TEARDOWN, and the order matters: `dispose` is the last check in this file
  // because it destroys the shared `game`. So the sky's part is asserted HERE,
  // on a throwaway mount, rather than by reaching into the final check.
  const scratch = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  const view = scratch.skyView
  const geometries = view._geometries.length
  const textures = view.textures.length
  assert.ok(geometries > 0, 'the sky tracked no geometries, so §15\'s teardown check would be satisfied by an empty world')
  assert.ok(textures > 0, 'the sky tracked no textures, so the two procedural canvases are not registered for disposal')
  scratch.dispose()
  assert.equal(view.disposed, true, 'the sky view did not dispose')
  assert.equal(view.root.parent, null, 'and did not remove itself from the scene')
  assert.equal(view._geometries.length, 0, 'and left its geometries behind')
  assert.equal(view.textures.length, 0, 'and its textures')
  assert.equal(view.root.children.length, 0, 'and its children')
  // ...and it is idempotent, because `dispose` may legitimately be called twice
  // on the way out of a hot reload.
  scratch.dispose()
  console.log(`\n  pass-9 cost: 3 bands on 1 geometry + 1 texture, ${sky.horizonMesh.count} horizon parts on 1 instanced box and 1 material, 1 point cloud, ${objects.length} drawable objects; teardown released ${geometries} geometries and ${textures} textures`)
})

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 10 — CREATURE FIDELITY I, against the BUILT scene
//
// What the pure harness cannot answer about this pass, and why each answer has to be
// here rather than in a screenshot:
//
//  1. the trail is ONE mesh, is a sibling of the figure rather than a child of it,
//     carries an RGBA vertex colour, and is queued BEFORE the eye — four properties
//     that are only true or false of the objects three.js will actually draw;
//  2. the buffer's contents are the MARKS, at the positions the world says, in the
//     copy the player is standing in, with the cap respected — a reducer can be
//     perfectly correct and still be handed nothing to draw;
//  3. the eye flare is visible in the BUILT material: the `THREE.Color` the renderer
//     tone-maps is 3.2x its unflared value on the spotting frame and back to 1x a
//     second later. The pure harness proves the envelope; only this can prove the
//     envelope reaches the framebuffer;
//  4. the rig actually breathes, the elbow actually lags, and two identical runs
//     produce byte-identical buffers — the determinism D10 asks for, measured on the
//     geometry rather than on the function that fills it.
// ---------------------------------------------------------------------------

/**
 * Read the trail buffer's live marks back out: quads with a non-zero alpha.
 *
 * The position read is the mark's CENTRE — the mean of its four corners — and not its
 * first vertex, because a quad is four corners of an ellipse and the first one is
 * `radius` away from the spot the reducer laid. Comparing a corner to a point and
 * calling the difference a bug is how this harness would have reported a mark at
 * 0.14 m from where it was put.
 */
function trailMarks(view) {
  const colour = view.trail.geometry.attributes.color
  const position = view.trail.geometry.attributes.position
  const out = []
  for (let mark = 0; mark < beast.TRAIL_MAX; mark += 1) {
    const alpha = colour.getW(mark * 4)
    if (alpha <= 0) continue
    const vertex = mark * 4
    let x = 0
    let y = 0
    let z = 0
    for (let corner = 0; corner < 4; corner += 1) {
      x += position.getX(vertex + corner)
      y += position.getY(vertex + corner)
      z += position.getZ(vertex + corner)
    }
    out.push({ alpha, x: x / 4, y: y / 4, z: z / 4 })
  }
  return out
}

check('pass-10: the trail is one mesh, a sibling of the figure, and queued before the eye', () => {
  game.restart()
  run(game, 0.5)
  const view = game.creatureView
  // ONE MESH. The whole trail is `TRAIL_MAX` quads in one buffer, so the pass costs
  // one draw call whatever is alive — which is the claim the InstancedMesh argument in
  // `_buildTrail` is about, and the cheapest thing here to check by counting.
  let named = 0
  game.scene.traverse((object) => {
    if (object.name === 'creatureTrail') named += 1
  })
  assert.equal(named, 1, `the world has ${named} trail meshes, and every extra one is a second draw call`)
  assert.ok(!view.trail.isInstancedMesh, 'the trail is instanced, which has no per-instance alpha in stock three.js')
  // A SIBLING OF THE FIGURE. A mark parented to `root` would travel with the creature
  // for ever, and a trail that follows the thing that laid it is a shadow.
  assert.equal(view.trail.parent, game.scene, 'the trail is not on the scene')
  assert.notEqual(view.trail.parent, view.root, 'the trail is parented to the creature, so it follows it')
  assert.notEqual(view.trail.parent, view.lean, 'or to its rig')
  // THE ORDER. `EYE_RENDER_ORDER` is pass 6's claim and this pass must not undo it,
  // and the trail has to be drawn first: a dark `depthWrite: false` decal sorted after
  // an additive eye erases the creature gate's only anchor, which is the pass-6 wire
  // bug arriving in a different vehicle.
  const eyes = view.eyes.children
  assert.equal(eyes.length, 2)
  for (const eye of eyes) {
    assert.ok(eye.renderOrder > view.trail.renderOrder, `the eye is at ${eye.renderOrder} and the trail at ${view.trail.renderOrder}, so a decal can paint over the eye`)
  }
  assert.equal(eyes[0].renderOrder, 1, 'pass 6 lifted the eye out of the depth sort and this pass undid it')
  // THE VERTEX COLOUR IS FOUR COMPONENTS, which is the only thing that makes a
  // per-mark alpha legal: three.js sets `USE_COLOR_ALPHA` from `itemSize === 4`, and a
  // three-component attribute compiles, runs, and discards the alpha.
  const colour = view.trail.geometry.attributes.color
  assert.equal(colour.itemSize, 4, 'the trail colour is not RGBA, so the per-mark fade is discarded')
  assert.equal(colour.count, beast.TRAIL_MAX * 4)
  assert.equal(view.trail.material.vertexColors, true, 'the material is not reading the vertex colour')
  assert.equal(view.trail.material.fog, true, 'a decal on the road has to recede with the road')
  assert.equal(view.trail.material.blending, THREE.NormalBlending, 'the mark is not an alpha blend')
  assert.equal(view.trail.material.depthWrite, false, 'a dark decal that writes depth is a sticker')
  assert.ok(view.trail.material.opacity < 1, `the mark peaks at opacity ${view.trail.material.opacity}, which is an opaque hole in the road`)
  assert.equal(view.trail.frustumCulled, false, 'the trail is frustum-culled, and its bounds are a static buffer whose vertices move')
  // AND IT STARTS EMPTY AND INVISIBLE, which is what makes a walk the only way to see one.
  assert.equal(view.trail.visible, false, 'a creature that has not walked is already trailing')
  assert.equal(trailMarks(view).length, 0)
  assert.equal(game.creatureTrail.marks.length, 0)
})

check('pass-10: walking lays marks, the cap holds, and they are drawn where the creature was', () => {
  game.restart()
  run(game, 1.6)
  // Act I's telegraph does not walk, and that is the first half of the claim: nothing is
  // laid for a figure that is on the field and motionless.
  assert.equal(game.creature.state, 'telegraph')
  run(game, 0.5)
  assert.equal(game.creatureTrail.marks.length, 0, 'the Act I apparition laid a trail without walking')
  assert.equal(game.creatureView.trail.visible, false)
  // Act II. A stalking thing walks toward its evidence, which is enough to lay a
  // trail, and the marks have to be on the road BEHIND where it now stands.
  game.state = { ...game.state, hammerHeld: true }
  game.creature = beast.createCreature({ state: 'stalk' })
  placeCreature(game, 26)
  game.update(DT)
  run(game, 3.0)
  const trail = game.creatureTrail
  assert.ok(trail.marks.length > 0, 'a stalking creature walked three seconds and left nothing')
  assert.ok(trail.walked > 0, 'and the world never measured how far it went')
  // THE CAP, on the BUILT buffer and not only on the reducer.
  assert.ok(trail.marks.length <= beast.TRAIL_MAX, `the trail holds ${trail.marks.length} marks`)
  assert.equal(game.creatureView.trail.geometry.attributes.position.count, beast.TRAIL_MAX * 4)
  const drawn = trailMarks(game.creatureView)
  assert.ok(drawn.length > 0, 'the world has marks and the buffer is empty')
  assert.equal(game.creatureView.trail.visible, true, 'a creature with a live trail is not drawing it')
  // THE FADE IS WHAT THE FUNCTION SAYS, read back off the buffer: the oldest listed mark
  // is the faintest, which is the brief's sentence in pixels rather than in data.
  // The buffer is OLDEST-FIRST — `dripStep` keeps its list in that order and the view
  // writes it slot for slot — so the alphas RISE along it, and that is the brief's
  // sentence read back in pixels: the oldest mark is the faintest one on the road.
  for (let i = 1; i < drawn.length; i += 1) {
    assert.ok(drawn[i].alpha > drawn[i - 1].alpha, `mark ${i} is at ${drawn[i].alpha.toFixed(3)} and the OLDER one at ${drawn[i - 1].alpha.toFixed(3)}, so the fade is not by age`)
  }
  assert.ok(drawn[0].alpha < 0.5, `the oldest mark is at ${drawn[0].alpha.toFixed(3)}, which is not a faded one`)
  assert.ok(drawn[drawn.length - 1].alpha < 1, `the newest mark is at full strength (${drawn[drawn.length - 1].alpha.toFixed(3)}), so it switched on rather than landed`)
  // THE FRAME. Every mark is in the copy the player is standing in, and on the road
  // rather than up in the air: a mark at the wrong height is a decal on a house.
  const origin = game.streetView.origin
  for (const mark of drawn) {
    assert.ok(Math.abs(mark.y - beast.DRIP_LIFT) < 1e-6, `a mark is at y=${mark.y}, which is not the road`)
    const canonical = { x: mark.x - origin.x, z: mark.z - origin.z }
    const found = trail.marks.some((entry) => Math.hypot(entry.x - canonical.x, entry.z - canonical.z) < 0.01)
    assert.ok(found, `a drawn mark at ${mark.x.toFixed(1)}, ${mark.z.toFixed(1)} is not in the trail at all once the fold is undone`)
  }
  // AND THE STAND-OFF, on the real predicate rather than on the source: the world asks
  // `clearOfPortals` every frame, the trail loses marks inside the radius, and the
  // count is published so this can require that it ever fired.
  const portal = game.streetView.portals[0]
  assert.ok(portal, 'the world has no portals')
  const gate = game.streetView.worldOf(portal.anchor.position)
  assert.equal(game.streetView.clearOfPortals(gate.x, gate.z), false, 'a spot on a gate is clear of the portals')
  const before = game.creatureTrail.suppressed
  game.creature = beast.createCreature({ state: 'stalk' })
  game.creaturePosition = { x: portal.anchor.position.x, z: portal.anchor.position.z + 2 }
  run(game, 1.2)
  assert.ok(game.creatureTrail.suppressed > before, 'the creature walked across a gate and laid no suppression count')
  console.log(`\n  pass-10 trail: ${drawn.length} marks drawn, ${game.creatureTrail.walked.toFixed(1)} m walked, ${game.creatureTrail.dropped} laid, ${game.creatureTrail.suppressed} suppressed at a gate`)
})

check('pass-10: the eyes flare on the frame the creature spots the player, and settle after', () => {
  game.restart()
  run(game, 1.6)
  const view = game.creatureView
  // §6.3's cone is tested on a position with no yaw, so the creature's forward is
  // `forwardOf(0)` — straight down -z. A sighting therefore needs the player at LOWER z
  // than the creature, and the probe below SEARCHES for a real §6.3 sighting rather than
  // assuming one: eight bearings, five ranges, and a check that a change to the cone
  // cannot quietly turn this into a check that never spots anything.
  const player = { x: game.player.pos.x, z: game.player.pos.z }
  const range = beast.detectionRange(0, 0)
  const origin = game.streetView.origin
  let placed = null
  for (const dz of [3, 4, 5, 6, -3, -4, -5, -6]) {
    for (const dx of [0, 1, -1, 2, -2]) {
      // The canonical position is what the world stores and the DRAWN one is what
      // `canSee` is asked about, and the two are a whole period apart here — which is
      // the same fold bug the harness's own `placeCreature` note records, and the reason
      // this probe builds the drawn copy rather than trusting the canonical one.
      const canonical = { x: hood.canonicalCoord(player.x) + dx, z: hood.canonicalCoord(player.z) + dz }
      const drawn = { x: canonical.x + origin.x, z: canonical.z + origin.z }
      if (!beast.canSee(drawn, { x: player.x, z: player.z }, { range, occluders: game.streetView.occluders() })) continue
      placed = { dx, dz, drawn, canonical }
      break
    }
    if (placed) break
  }
  assert.ok(placed, 'no placement within 6 m of the player is a §6.3 sighting, so this check can never fire')
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.6 })
  game.creaturePosition = placed.canonical
  game.update(DT)
  // BEFORE. A stalking eye is at its normal glow, and `spotElapsed` is `null`, which is
  // what keeps the flare off every Act I frame and off every banish.
  assert.equal(game.spotElapsed, null, 'a stalking creature has already spotted the player')
  assert.equal(view.pose.eyeFlare, 0, 'a stalking eye is flaring')
  const calm = view.eyeMaterial.color.clone()
  const calmScale = view.eyes.scale.x
  assert.ok(calmScale > 0, 'the eye quad has no scale at all')
  // THE SPOT. Fill the meter until §6.2 crosses 1.0 and the state machine turns it into
  // a chase, and take the FIRST frame on which the world says so.
  let spot = null
  for (let frame = 0; frame < 900; frame += 1) {
    // Re-pinned every frame, and the reason is §11.1: at three metres and tier 0's
    // 2.2 m/s the creature reaches the player and CAPTURES inside two seconds, which is
    // four seconds before §6.2's meter finishes filling. The sighting edge is between
    // those two events, and this check is about the edge.
    game.creaturePosition = placed.canonical
    game.update(DT)
    if (game.creature.state !== 'chase') continue
    spot = { frame, colour: view.eyeMaterial.color.clone(), scale: view.eyes.scale.x, pose: view.pose.eyeFlare }
    break
  }
  assert.ok(spot, `a creature staring at the player from ${Math.hypot(placed.dx, placed.dz)} m never reached a chase in 10 s`)
  assert.equal(game.spotElapsed, 0, 'the spot clock did not start on the spotting frame')
  assert.equal(spot.pose, 1, 'the pose does not carry a full flare on the frame the creature spots you')
  // AND THE BUILT MATERIAL. This is the assertion the pure harness cannot make: the
  // `THREE.Color` the renderer will tone-map is brighter on this frame than it was, and
  // brighter by the documented gain.
  const lit = spot.colour.r / calm.r
  assert.ok(lit > beast.EYE_FLARE_GAIN, `the eye brightened by ${lit.toFixed(2)}x and EYE_FLARE_GAIN is ${beast.EYE_FLARE_GAIN}`)
  assert.ok(lit < beast.EYE_FLARE_GAIN + 1.6, `the eye is ${lit.toFixed(2)}x, which is a headlight`)
  assert.ok(spot.scale > calmScale, 'the flaring eye did not swell at all')
  // THE SWELL IS 20% AND NOT AN INFINITY, which is the eye-finder's own ceiling: a quad
  // grown past `EYE_MAX_SPAN` would stop being findable and the creature gate would lose
  // its anchor, so the growth is a constant and not a free parameter.
  const swell = spot.scale / calmScale
  assert.ok(swell > 1.05 && swell < beast.EYE_FLARE_GROWTH + 0.02, `the eye swelled ${swell.toFixed(3)}x against a documented ${beast.EYE_FLARE_GROWTH}`)
  // THE SETTLE. One frame later it is still bright, and after the window it is EXACTLY
  // the unflared colour again — `setHex` rewrites the colour every frame, so nothing
  // can accumulate across frames. Every frame from here is PINNED for the same reason
  // the spot loop was: an unpinned chase at three metres captures inside two seconds
  // and the capture is what this check would then be measuring.
  const advance = (seconds) => {
    for (let i = 0; i < Math.round(seconds / DT); i += 1) {
      if (game.creature.state === 'chase') game.creaturePosition = placed.canonical
      game.update(DT)
    }
  }
  advance(DT)
  assert.ok(view.eyeMaterial.color.r / calm.r > 1.5, 'the flare lasted one frame')
  advance(beast.EYE_FLARE_SECONDS + 0.2)
  assert.equal(game.creature.state, 'chase', 'the pinned chase did not survive its own meter')
  const settled = view.eyeMaterial.color.r / calm.r
  assert.ok(Math.abs(settled - 1) < 0.02, `the eye settled at ${settled.toFixed(3)}x its normal colour, so the flare accumulated`)
  // THE SIZE, as a CONTROLLED pair rather than as a comparison across two states: the
  // same pose at a fixed distance, presented once with the flare and once without, so
  // the only thing that can move the quad is `eyeFlare`. Comparing the settled size
  // against the size from BEFORE the spot would be comparing a chase against a stalk,
  // and the figure's own `scale` column is the difference.
  const poseAt = (sinceSpot) => beast.creaturePose(
    { state: 'chase' },
    { time: 3, distance: 12, sinceSpot, offset: view.flickerOffset, view: view.viewOf(game.camera) },
  )
  view.present(poseAt(null), { yaw: 0 })
  const plain = view.eyes.scale.x
  view.present(poseAt(0), { yaw: 0 })
  const swelled = view.eyes.scale.x
  assert.ok(
    Math.abs(swelled / plain - beast.EYE_FLARE_GROWTH) < 1e-9,
    `a flaring eye is ${(swelled / plain).toFixed(4)}x its size and EYE_FLARE_GROWTH is ${beast.EYE_FLARE_GROWTH}`,
  )
  view.present(poseAt(beast.EYE_FLARE_SECONDS), { yaw: 0 })
  assert.equal(view.eyes.scale.x, plain, 'the eye did not go back to exactly the size it had before the flare')
  assert.equal(view.eyeMaterial.color.r, calm.r, 'and the colour is not the unflared one either')
  // AND LEAVING A CHASE RE-ARMS IT, which is the difference between a telegraph and a
  // lamp: §6.3's release threshold drops the state back to `stalk`, the world clears the
  // clock, and the next chase has to announce itself again. The meter is handed to the
  // state machine rather than waited for, so the assertion is about the WORLD's clear
  // and not about §6.2's eight seconds.
  game.creature = beast.createCreature({ state: 'chase', awareness: beast.AWARENESS_CHASE_RELEASE - 0.05 })
  game.creaturePosition = placed.canonical
  game.update(DT)
  assert.equal(game.creature.state, 'stalk', 'a meter under the release threshold did not end the chase')
  assert.equal(game.spotElapsed, null, `leaving a chase left the spot clock at ${game.spotElapsed}`)
  console.log(`\n  pass-10 eye: spotted on frame ${spot.frame}, ${lit.toFixed(2)}x colour and ${swell.toFixed(2)}x size at the peak, settled to ${settled.toFixed(3)}x after ${beast.EYE_FLARE_SECONDS} s`)
})

check('pass-10: the rig breathes, the elbow lags, and the whole thing is deterministic', () => {
  game.restart()
  run(game, 1.6)
  const view = game.creatureView
  // THE BREATH, on the built rig. §14.3 is respected elsewhere in the world and the
  // creature's idle motion is not one of the suppressed terms — reduced motion covers
  // the PLAYER's head bob, the shake and the finale effects — so this is a scale the
  // figure really does breathe with, and it is a scale away from 1 that changes.
  game.creature = beast.createCreature({ state: 'stalk' })
  placeCreature(game, 30)
  const scales = []
  const yaws = []
  for (let frame = 0; frame < 240; frame += 1) {
    game.update(DT)
    scales.push(view.lean.scale.x)
    yaws.push(view.lean.rotation.y)
  }
  const spread = Math.max(...scales) - Math.min(...scales)
  const swaySpread = Math.max(...yaws) - Math.min(...yaws)
  assert.ok(spread > 0.01, `the figure's scale moved ${spread.toFixed(5)} over four seconds, which is not breathing`)
  assert.ok(spread < 0.05, `the figure's scale moved ${spread.toFixed(4)}, which is a pulse and not a breath`)
  assert.ok(swaySpread > 0.01, `the figure's shoulders yawed ${swaySpread.toFixed(5)} rad, which is not a sway`)
  assert.ok(Math.max(...scales) < 1.02, 'a breath can inflate the figure, but not by two per cent')
  assert.ok(Math.min(...scales) > 0.98, 'and it is a breath, so it comes back down')
  // IT IS A BREATH AND NOT A BOB: the crown moves and the feet do not, which is what a
  // scale on `lean` (whose origin is the floor) buys and a position offset would not.
  assert.ok(Math.abs(view.lean.position.y - (view.pose.heave + view.pose.lift)) < 1e-9, 'the bob and the breath are on the same term')
  // THE ELBOW, on the built rig, and the lag measured off the two curves rather than off
  // the constant: the arm reaches furthest forward, and the forearm's deepest bend has
  // to arrive after it.
  // Swept over one stride and post-processed, rather than tracked inline, and the
  // reason is worth recording: the phase is `heave x STRIDE_ARC` and `heave` is itself
  // an oscillation, so the arm's forward reach and the elbow's deepest bend are two
  // minima of two different curves and neither is known until the sweep is over. A
  // single-pass version latches onto the first crossing and measures a lag of nothing.
  const STRIDE_SWEEP = 2400
  const armSeries = []
  const elbowSeries = []
  for (let i = 0; i < STRIDE_SWEEP; i += 1) {
    view.present(beast.creaturePose({ state: 'chase' }, { time: i / 600, offset: 0 }), { yaw: 0 })
    armSeries.push(view.arms[0].rotation.x)
    elbowSeries.push(view.elbows[0].rotation.x)
  }
  const forwardMost = Math.min(...armSeries)
  const reachIndex = armSeries.indexOf(forwardMost)
  // the elbow's deepest bend, searching FORWARD from the reach and wrapping once, which
  // is what "the next bend in the stride" means
  let bentMost = Infinity
  let elbowIndex = -1
  for (let k = 0; k < STRIDE_SWEEP; k += 1) {
    const index = (reachIndex + k) % STRIDE_SWEEP
    if (elbowSeries[index] < bentMost) {
      bentMost = elbowSeries[index]
      elbowIndex = index
    }
  }
  const lagSeconds = ((elbowIndex - reachIndex + STRIDE_SWEEP) % STRIDE_SWEEP) / 600
  assert.ok(reachIndex >= 0, 'a chase never reached forward in four seconds')
  assert.ok(forwardMost < -0.3, `the arm only reached ${forwardMost.toFixed(3)} rad forward, so the stride is not being driven`)
  assert.ok(lagSeconds > 0, 'the elbow is most bent BEFORE the arm reaches forward, which is a broken elbow')
  assert.ok(lagSeconds < 0.6, `the elbow lags ${lagSeconds.toFixed(3)} s, which is a limb that has come apart`)
  assert.ok(bentMost < -0.3, `the elbow barely bends (${bentMost.toFixed(3)} rad), so the arm is still a stick`)
  assert.equal(view.elbows[0].rotation.x, view.elbows[1].rotation.x, 'the two elbows bend opposite ways, which is a bird')
  assert.notEqual(view.arms[0].rotation.x, view.arms[1].rotation.x, 'the two arms are in phase, so the figure marches')
  // AND THE RIG IS A RIG: two joints per arm, and the claw still hangs at `armLength`
  // from the shoulder, which is the silhouette §12.1 measures.
  const S = beast.CREATURE_SHAPE
  assert.equal(view.elbows.length, 2)
  // The elbow's LOCAL height, not its world height: the rig is pitched, scaled by the
  // breath and lifted by the bob, so a world Y is four other claims multiplied together
  // and a check on it is a check on all of them at once. This one is about where the
  // joint is hung — `armUpper` below the shoulder, which is what makes the forearm's
  // tip land on `armLength` and the silhouette 7:1.
  assert.equal(view.elbows[0].position.y, -S.armUpper, 'the elbow is not hung one upper-bone length below the shoulder')
  assert.equal(view.elbows[1].position.y, -S.armUpper)
  const upper = view.arms[0].children.find((child) => child.isMesh)
  assert.ok(upper, 'the shoulder has no upper bone on it')
  assert.equal(upper.position.y, -S.armUpper / 2, 'the upper bone is not centred on its own length')
  // A TELEGRAPH IS BARELY THERE, which is the half of the stride claim a stalk frame
  // cannot show: the same three numbers on the Act I apparition produce a fifth of the
  // chase's swing, and the whole of the apparition is that you are not sure.
  let chaseSwing = 0
  let telegraphSwing = 0
  for (let i = 0; i < 600; i += 1) {
    const t = i / 100
    view.present(beast.creaturePose({ state: 'chase' }, { time: t, offset: 0 }), { yaw: 0 })
    chaseSwing = Math.max(chaseSwing, Math.abs(view.arms[0].rotation.x))
    view.present(beast.creaturePose({ state: 'telegraph' }, { time: t, offset: 0 }), { yaw: 0 })
    telegraphSwing = Math.max(telegraphSwing, Math.abs(view.arms[0].rotation.x))
  }
  assert.ok(chaseSwing > telegraphSwing * 8, `a chase swings ${chaseSwing.toFixed(3)} rad and a telegraph ${telegraphSwing.toFixed(3)}`)
  // DETERMINISM, and the FORM of the claim is the point: the same walk, driven twice,
  // has to produce the same buffer. A `Math.random` in a mark's shape, or a clock read
  // in the view, would pass every check above and fail this one.
  //
  // It is two FRESH worlds rather than this one and a scratch, and the reason is that a
  // determinism claim is a claim about a seed and a frame count, not about a world that
  // has already been through eighty-eight checks. `game` here has a different
  // `animTime` from a scratch by two hundred seconds of simulation, its creature has a
  // history, and the walk it takes is a walk through that history. Both marks would be
  // seeded identically and neither would be a replay, so comparing them would measure
  // the harness's own history instead of the trail's determinism.
  const walk = (target) => {
    target.restart()
    run(target, 1.6)
    target.state = { ...target.state, hammerHeld: true }
    target.creature = beast.createCreature({ state: 'stalk' })
    placeCreature(target, 26)
    run(target, 2.5)
    return Array.from(target.creatureView.trail.geometry.attributes.position.array)
      .map((value) => value.toFixed(6))
  }
  const mount = () => new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  const one = mount()
  const two = mount()
  const first = walk(one)
  const second = walk(two)
  assert.ok(first.length > 0, 'the determinism walk laid no marks at all')
  assert.equal(one.seed, two.seed, 'the two worlds are not the same seed, so nothing else is comparable')
  assert.deepEqual(first, second, 'the same walk produced two different trails, so a mark is not reproducible')
  // ...and the marks are not all at the origin, or "identical" is a claim about a buffer
  // of zeroes. `placeCreature` walks it 26 m out and the trail follows it down the road,
  // so the marks have to SPAN metres for the comparison to be about a trail.
  const laid = one.creatureTrail.dropped
  const spread2 = trailMarks(one.creatureView)
  assert.ok(laid > 3, `the determinism walk laid ${laid} marks, which is too few to be a trail`)
  const xs = spread2.map((mark) => mark.x)
  assert.ok(Math.max(...xs) - Math.min(...xs) > 1, `the ${spread2.length} marks span ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} m, which is a single spot`)
  one.dispose()
  two.dispose()
  console.log(`\n  pass-10 rig: scale ${spread.toFixed(4)} over 4 s, shoulders ${swaySpread.toFixed(4)} rad, elbow lag ${lagSeconds.toFixed(3)} s and ${bentMost.toFixed(2)} rad, chase swings ${chaseSwing.toFixed(3)} rad against a telegraph's ${telegraphSwing.toFixed(3)}, ${laid} marks reproduced exactly across two fresh worlds`)
})

check('pass-10: a trail mark lands INSIDE the frame, and the gallery stages one that does', () => {
  // THE PASS-10 REVIEW FINDING, and the only place in the repository that can
  // catch it, because it is the only place with a camera.
  //
  // Pass 10 shipped a viscous trail with nineteen mutations, four world checks and
  // a whole section of prose, and every one of them was about the mark EXISTING:
  // that the reducer lays one per `DRIP_STRIDE_METRES`, that the cap evicts the
  // oldest, that the buffer's contents are the marks. Not one of them asked
  // whether a mark is ever in front of a camera. So the gallery shipped with the
  // feature in no frame of it, and nothing could see that:
  //
  //   creature-stalking  0.35 s -> 0.77 m, no mark laid at all
  //   creature-chasing   0.30 s -> 0.62 m, no mark laid at all
  //   banish             0.45 s -> 0.99 m, one mark laid — at the creature's feet,
  //                              1.0 m from a camera 1.6 m up, which projects to
  //                              y=1213 in a 720-tall frame. 493 px below the
  //                              bottom edge. On screen: nothing.
  //
  // So "a mark exists" and "a mark is in a picture" are different claims, and only
  // the second one is the one a reviewer is ever going to see. This check is the
  // second claim, and it is deliberately a projection rather than a threshold on
  // alpha: a mark can be at full strength and still be under the camera.
  //
  // WHY THE CAMERA MATRICES ARE FORCED
  // ----------------------------------
  // `project()` is only meaningful once `matrixWorldInverse` is current, and in
  // this harness nothing renders, so it is never refreshed. Left alone it is the
  // identity matrix and EVERY world point projects to the same pixel — a mark at
  // 3 m and a mark at 26 m land on top of each other, and a check built on that
  // would pass for the wrong reason. The helper below refreshes all three matrices
  // and is used by everything here that reasons about screen space.
  const refreshCamera = () => {
    const camera = game.camera
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    return camera
  }

  // A mark is VISIBLE if it projects inside the frame and is still wet enough to
  // read. The alpha floor is `DRIP_SPREAD`-aware rather than a literal: a mark
  // inside its own spread ramp is still arriving, and the harness's `wait` can
  // catch one there, so the floor asks for a mark that has actually landed.
  const VISIBLE_ALPHA = 0.15
  const inFrame = (mark, time) => {
    const camera = refreshCamera()
    const drawn = game.streetView.worldOf({ x: mark.x, z: mark.z })
    const point = new THREE.Vector3(drawn.x, beast.DRIP_LIFT, drawn.z).project(camera)
    const x = (point.x * 0.5 + 0.5) * 1280
    const y = (-point.y * 0.5 + 0.5) * 720
    return {
      x,
      y,
      visible: x >= 0 && x < 1280 && y >= 0 && y < 720 && beast.dripAlpha(time - mark.born) > VISIBLE_ALPHA,
    }
  }

  // The camera projection is not a thing this harness may assume: with the
  // matrices stale, three ground points at 3/8/16/26 m all project to the same
  // pixel. A control that cannot distinguish a near point from a far one would
  // make every assertion below meaningless, so it is asserted directly.
  {
    game.restart()
    game.start()
    run(game, 1.6)
    refreshCamera()
    const at = (metres) => {
      const point = new THREE.Vector3(
        game.player.pos.x - Math.sin(game.player.yaw) * metres,
        beast.DRIP_LIFT,
        game.player.pos.z - Math.cos(game.player.yaw) * metres,
      ).project(game.camera)
      return { x: (point.x * 0.5 + 0.5) * 1280, y: (-point.y * 0.5 + 0.5) * 720 }
    }
    const near = at(3)
    const far = at(26)
    assert.ok(
      Math.hypot(far.x - near.x, far.y - near.y) > 40,
      `the camera projects a point at 3 m and one at 26 m to within ` +
        `${Math.hypot(far.x - near.x, far.y - near.y).toFixed(1)} px of each other (${near.x.toFixed(0)},` +
        `${near.y.toFixed(0)} vs ${far.x.toFixed(0)},${far.y.toFixed(0)}), so its matrices are stale and ` +
        'nothing measured in screen space here means anything',
    )
  }

  // THE BANISH FRAME, measured rather than argued: this is the one that crossed
  // the time floor and still put its mark nowhere. It is asserted as a documented
  // limitation instead of being quietly dropped, because "off-screen under the
  // camera" is the general failure of a decal feature and the next pass will hit
  // it again.
  const banish = cap.captureView('banish')
  {
    const seconds = banish.steps
      .slice(banish.steps.findIndex((step) => step.op === 'creature') + 1)
      .filter((step) => step.op === 'wait')
      .reduce((total, step) => total + step.seconds, 0)
    const spec = banish.steps.find((step) => step.op === 'creature')
    game.restart()
    // `start()` as well: `restart()` alone leaves the phase at RESET, and §9.3
    // says no figure may be shown in that phase, so the world would correctly
    // decline to draw one and the trail would never be advanced. Every check that
    // needs a live world says both.
    game.start()
    run(game, 1.6)
    // the harness's own helper, which takes a straight dx/dz in the CANONICAL
    // frame (`creaturePosition` is canonical, §3.3) rather than a view-axis point
    placeCreature(game, 0, -spec.metres)
    game.creature = beast.createCreature({ state: spec.state, awareness: 0.45 })
    game.dismissing = false
    game.dismissElapsed = 0
    game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
    run(game, seconds)
    const marks = game.creatureTrail.marks
    const seen = marks.map((mark) => inFrame(mark, game.animTime)).filter((entry) => entry.visible)
    assert.equal(
      seen.length,
      0,
      `banish now lays a mark that IS in frame (${seen.length} visible at ` +
        `${seen.map((e) => `${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' ')}), which is better than this ` +
        'check assumed — update its comment and the staging note in capture.js rather than deleting it',
    )
  }

  // THE CLAIM, on the view that carries it. `creature-chasing` is staged at
  // tier-0 speed for long enough to walk past `DRIP_STRIDE_METRES`, and this
  // asserts the marks it lays are inside the frame — the property that was false
  // for the whole of pass 10, and the reason `verify.mjs` asks only the weaker
  // time question of the staging data.
  const chase = cap.captureView('creature-chasing')
  {
    const seconds = chase.steps
      .slice(chase.steps.findIndex((step) => step.op === 'creature') + 1)
      .filter((step) => step.op === 'wait')
      .reduce((total, step) => total + step.seconds, 0)
    const spec = chase.steps.find((step) => step.op === 'creature')
    game.restart()
    // `start()` as well: `restart()` alone leaves the phase at RESET, and §9.3
    // says no figure may be shown in that phase, so the world would correctly
    // decline to draw one and the trail would never be advanced. Every check that
    // needs a live world says both.
    game.start()
    run(game, 1.6)
    // the harness's own helper, which takes a straight dx/dz in the CANONICAL
    // frame (`creaturePosition` is canonical, §3.3) rather than a view-axis point
    placeCreature(game, 0, -spec.metres)
    game.creature = beast.createCreature({ state: spec.state, awareness: 1 })
    game.dismissing = false
    game.dismissElapsed = 0
    game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
    run(game, seconds)
    const marks = game.creatureTrail.marks
    const projected = marks.map((mark) => inFrame(mark, game.animTime))
    const seen = projected.filter((entry) => entry.visible)
    assert.ok(marks.length > 0, `${chase.id} is staged for ${seconds}s and laid no mark at all`)
    assert.ok(
      seen.length > 0,
      `${chase.id} laid ${marks.length} mark(s) and NONE of them is inside the frame — they project to ` +
        `${projected.map((e) => `${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' ')} in a 1280x720 shot. ` +
        'The trail is in no picture, which is the pass-10 bug this check exists for. Stage the ' +
        'creature further out, or give it longer, so the marks land where the camera can see them.',
    )
    // and it is a real chase at the shutter, not a stalk wearing a chase's filename
    assert.equal(game.creature.state, 'chase', `${chase.id} waits ${seconds}s and the creature is no longer chasing`)
    console.log(
      `\n  pass-10 picture: ${chase.id} lays ${marks.length} mark(s), ${seen.length} inside the frame at ` +
        `${seen.map((e) => `${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' ')}; ` +
        `banish's ${game.creatureTrail.marks.length === 0 ? 0 : 1} mark is off-screen under the camera, as documented`,
    )
  }
})
/**
 * `lampDreaded` — the built sodium light's state, as a record a check can reason about.
 *
 * ITERATION 2, PASS 11. Three numbers, and the reason a helper exists is that the
 * interesting assertions are about RELATIONSHIPS between them (is the drodded light
 * dimmer than the untouched one, does the bounce move with the key) and reading
 * `game.lampLights[i].intensity` at four different call sites is how a check ends up
 * comparing a base to a base.
 */
function lampReadout(game) {
  return {
    dread: { ...game.lampDread },
    keys: game.lampLights.map((light, i) => ({
      index: i,
      visible: light.visible,
      intensity: light.intensity,
      bounce: game.bounceLights[i] ? game.bounceLights[i].intensity : 0,
      // The bounce is a SEPARATE light with its own visibility, and `_writeLampDread`
      // only writes the one whose `visible` is true. A slot can therefore have a lit key
      // over a dark bounce, and a check that asserts a bounce level has to say which of
      // the two it is looking at — the pass-11 review hit exactly that and asserted 46 on
      // a bounce that had never been turned on.
      bounceVisible: game.bounceLights[i] ? game.bounceLights[i].visible === true : false,
    })),
  }
}

check('pass-11: the shimmer is built as one additive ring, and its bands clear the body', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  const view = game.creatureView
  // ONE MESH, like the trail and for the same reason: six bands as six meshes is six
  // draw calls for a column the eye integrates into one.
  let named = 0
  game.scene.traverse((object) => {
    if (object.name === 'creatureHaze') named += 1
  })
  assert.equal(named, 1, `the world has ${named} shimmer meshes, and every extra one is a second draw call`)
  assert.ok(!view.haze.isInstancedMesh, 'the shimmer is instanced, which has no per-vertex alpha in stock three.js')
  assert.equal(view.haze.material.blending, 2, 'the shimmer is not additive, so it is a grey stain rather than light')
  assert.equal(view.haze.material.fog, false, 'the shimmer is fogged, so it ADDS the fog colour')
  // ...and the ring has a hole. The four-component colour attribute is what makes the
  // per-vertex alpha legal at all, and the alpha is zero on the inner edge: measured off
  // the built buffer rather than read out of the source, because a source claim cannot
  // see a geometry that was never written.
  const colour = view.haze.geometry.attributes.color
  const position = view.haze.geometry.attributes.position
  assert.equal(colour.itemSize, 4, 'the shimmer colour attribute is not RGBA, so the band fade is discarded')
  assert.equal(position.count, beast.HAZE_LAYERS * 4 * 4, `the shimmer has ${position.count} vertices, not HAZE_LAYERS x 4 quads`)
  // Put the creature close and present, and read the buffer that is about to be drawn.
  placeCreature(game, 0, -4)
  game.creature = beast.createCreature({ state: 'chase', awareness: 1 })
  game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
  game.update(DT)
  assert.equal(view.haze.visible, true, 'a creature four metres away is not shimmering')
  let innerLit = 0
  let outerLit = 0
  for (let band = 0; band < beast.HAZE_LAYERS; band += 1) {
    for (let side = 0; side < 4; side += 1) {
      const vertex = (band * 4 + side) * 4
      // The band is an ANNULUS and its four corners are ordered inner-top, outer-top,
      // outer-bottom, inner-bottom against an alpha ramp of `[0, 1, 1, 0]` — so corners
      // 1 and 2 are the OUTER edge and carry the band's strength, and 0 and 3 are the
      // inner edge and must carry none. Read as a count rather than a comparison so the
      // assertion is about the geometry rather than about one band's moment in time.
      if (colour.getW(vertex + 1) > 0) outerLit += 1
      if (colour.getW(vertex) > 0) innerLit += 1
    }
  }
  assert.equal(outerLit, beast.HAZE_LAYERS * 4, `only ${outerLit} of the ${beast.HAZE_LAYERS * 4} outer edges carry the band alpha`)
  assert.equal(innerLit, 0, `${innerLit} inner edges are lit, so the curtain is painted over the creature`)
  // ...and the hole is wide enough for the figure, measured on the BUILT buffer: the
  // smallest distance from the column's axis to any lit vertex, against the widest the
  // rig ever gets. `creature-stalking.png` has 0.013 of headroom on the body/surround
  // ratio this protects, so the number is measured rather than reasoned about.
  let narrowest = Infinity
  for (let band = 0; band < beast.HAZE_LAYERS; band += 1) {
    for (let side = 0; side < 4; side += 1) {
      const vertex = (band * 4 + side) * 4
      const y = position.getY(vertex)
      const radial = Math.hypot(position.getX(vertex), position.getZ(vertex))
      const body = (y <= beast.CREATURE_SHAPE.armRoot ? beast.CREATURE_SHAPE.hip / 2 : beast.CREATURE_SHAPE.shoulder / 2) * game.creatureView.pose.scale
      if (radial - body < narrowest) narrowest = radial - body
    }
  }
  assert.ok(narrowest > 0.05, `the nearest lit shimmer pixel is ${narrowest.toFixed(3)} m from the body it is shimmering around`)
  // AND IT IS OFF when the creature is not, which is the artefact this pass could ship
  // that nothing else would notice: a column of hot air standing where a banished thing
  // used to be. Both routes to "not there" are checked, because they are different
  // frames: the pose going absent, and the pose never having had one.
  game.creature = beast.createCreature({ state: 'dormant' })
  game.update(DT)
  assert.equal(view.haze.visible, false, 'the shimmer is still up for a creature that is not there')
  assert.equal(view.pose.haze, 0)
  game.restart()
  game.update(DT)
  assert.equal(view.haze.visible, false, "the shimmer is up on the title screen's dormant frame")
  // ...and off beyond the radius, by construction rather than by a retunable constant.
  placeCreature(game, 0, -beast.HAZE_RADIUS - 4)
  game.creature = beast.createCreature({ state: 'chase', awareness: 1 })
  game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
  game.update(DT)
  assert.equal(view.pose.haze, 0, `a creature ${beast.HAZE_RADIUS + 4} m away is at haze ${view.pose.haze}`)
  assert.equal(view.haze.visible, false)
})

check('pass-11: the lamp under the creature strobes on the built light, and recovers', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  // FIND A LAMP TO STAND UNDER, rather than assuming one is in range. The four lit
  // lamps are the nearest to the PLAYER, and the creature is somewhere else entirely, so
  // "the nearest lamp" is a question this check has to answer against the world's own
  // aimed list — which is also the list `_writeLampDread` reads, so the two cannot
  // disagree about which lamp is which.
  const aimed = game.streetView.lampsNear(game.player.pos.x, game.player.pos.z, 96)
  assert.ok(aimed.length > 0, 'the light pool has no lamps in it at all, so this check can never fire')
  const lamp = aimed[0]
  // STAND THE CREATURE UNDER IT, in the CANONICAL frame the world keeps it in (§3.3),
  // one metre north so it is inside the radius and not on the lamp's own position.
  // `canonicalCoord` IS the fold: it takes a world coordinate and returns the canonical
  // one, which is what `creaturePosition` holds. Subtracting `origin` as well — the first
  // version of this helper did, and the tell was that a creature placed one metre from
  // the lamp drodded nothing at all — folds twice and puts the creature 448 m away. The
  // pass-10 harness's own `placeCreature` says the same thing in one line: the frame is
  // stated once, and it is this.
  const put = (metres) => {
    game.creaturePosition = {
      x: hood.canonicalCoord(lamp.x + metres),
      z: hood.canonicalCoord(lamp.z),
    }
  }
  // BEFORE. A creature 40 m from the nearest lamp is not a neighbour of it.
  put(40)
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.4 })
  game.update(DT)
  const base = lampReadout(game)
  assert.equal(base.dread.level, 1, `a creature 40 m from the lamp drodded it to ${base.dread.level}`)
  assert.ok(base.keys.some((key) => key.intensity > 0), 'no lamp light is on at all')
  // UNDER IT. The level has to be BELOW one on some ticks and the built `THREE` light's
  // intensity has to move with it — the pure module's number and the renderer's number
  // are two different objects, and a wiring that computed the level and forgot to apply
  // it would pass every check in `verify.mjs`.
  put(1)
  let lowest = 1
  let highest = 0
  let dimmed = 0
  const samples = 240
  // THE WIRING CLAIM, FRAME FOR FRAME AND EXACTLY. On every one of these frames the
  // built `THREE.PointLight.intensity` has to BE the pure function's answer for the
  // distance the world measured and the clock it is on — not "about" it, not on average.
  // This is the assertion the whole lamp effect rests on, and it is the one the first
  // version of this check could not make: it compared WINDOW MEANS, and a mean of eleven
  // one-in-three drops is a coin, so it read 261.9 where the pure mean at the same
  // distance is 217.0 and reported a fault that was not there. A gate that compares
  // through a noisy statistic is a gate that can only be satisfied by being loose.
  const seed = beast.lampDreadSeed(game.seed, 0)
  for (let i = 0; i < samples; i += 1) {
    run(game, 1 / 60)
    const now = lampReadout(game)
    const drodded = now.keys[0]
    lowest = Math.min(lowest, drodded.intensity / 400)
    highest = Math.max(highest, drodded.intensity / 400)
    if (drodded.intensity < 400 - 1e-6) dimmed += 1
    const expected = 400 * beast.lampDread(now.dread.distance, game.animTime, { seed })
    assert.ok(
      Math.abs(drodded.intensity - expected) < 1e-6,
      `frame ${i}: the built light is at ${drodded.intensity} and 400 x lampDread(${now.dread.distance.toFixed(3)} m, ${game.animTime.toFixed(4)} s) is ${expected.toFixed(6)}`,
    )
    // ...and the BOUNCE moves with the key, because the bounce IS the sodium returning
    // off the road and a strobed key over a steady bounce is a light being eaten from
    // above. The bounce is 46 at rest, so the two are the same number on two channels.
    assert.ok(
      Math.abs(drodded.bounce - 46 * (drodded.intensity / 400)) < 1e-6,
      `the key is at ${drodded.intensity.toFixed(1)} and the bounce at ${drodded.bounce.toFixed(1)}, which is not the same level`,
    )
  }
  assert.ok(lowest < 0.35, `the strobe bottoms out at ${(lowest * 100).toFixed(0)}% of the base over ${samples} frames`)
  assert.ok(highest > 0.9, `the strobe never comes back up (best ${(highest * 100).toFixed(0)}%)`)
  assert.ok(dimmed > samples * 0.15, `the lamp was dimmed on only ${dimmed} of ${samples} frames, so nothing is strobing`)
  // ...and the OTHER lit lamps are untouched, which is the "nearest lamp" half of the
  // brief and the difference between a presence in a place and a global dimmer.
  const spread = lampReadout(game)
  const others = spread.keys.slice(1).filter((key) => key.visible)
  for (const key of others) {
    assert.ok(Math.abs(key.intensity - 400) < 1e-6, `lamp ${key.index} is at ${key.intensity} while the creature is under lamp 0`)
  }
  // AND THE PUBLISHED RECORD matches the built light, which is the point of publishing
  // it: `dread.level` and `keys[0].intensity / 400` are the same number read two ways.
  const published = spread.dread
  assert.equal(published.lamp, 0, `the world says lamp ${published.lamp} was drodded, and the creature is under lamp 0`)
  assert.ok(Math.abs(published.level - spread.keys[0].intensity / 400) < 1e-9, 'the published level and the built intensity disagree')
  assert.ok(published.distance < beast.LAMP_DREAD_RADIUS, `the world measured ${published.distance.toFixed(1)} m to the lamp it drodded`)
  // AND IT RECOVERS, which is the half of the brief that is a claim about time: walk the
  // creature out of the radius and the light comes back to exactly its base.
  put(beast.LAMP_DREAD_RADIUS + 6)
  run(game, 0.2)
  const after = lampReadout(game)
  assert.equal(after.dread.level, 1, `a creature 6 m past the radius left the lamp at ${after.dread.level}`)
  assert.ok(Math.abs(after.keys[0].intensity - 400) < 1e-6, `the lamp is at ${after.keys[0].intensity} with nothing standing under it`)
  // ...and the two ENDS of the ramp, which is what this harness can see and what the
  // pure module's monotone sweep above already owns in full. There is deliberately no
  // twenty-step sweep here: a hashed square wave's window mean is a coin at every window
  // length a headless world can afford, and the first version of this check spent its
  // whole budget learning that. The wiring is now asserted exactly, frame by frame; what
  // is left for the world is the RAMP — a lamp at the centre of the radius is measurably
  // darker than one at the edge of it, and measurably brighter than one outside it.
  const atRadius = beast.LAMP_DREAD_RADIUS - beast.LAMP_DREAD_FADE
  // The sample carries its own EXPECTATION: the pure function evaluated at the very
  // frames and the very distances the world used, so the comparison is like for like and
  // the noise cancels instead of having to be tolerated. This is the third attempt at
  // this assertion and the reason is worth recording: comparing two INDEPENDENT window
  // means of a hashed one-in-three dropout does not work, because the spread of a
  // 22-tick mean is not the +/-3.6% a binomial predicts. Measured on four seeds, six
  // consecutive 22-tick windows each, the same distance gives means from 0.539 to 0.734 —
  // a +/-18% band, because the hashed pattern is not independent from tick to tick at the
  // scale of a short window. A gate that compares through a noisy statistic is a gate
  // that can only be satisfied by being loose.
  const sample = (metres, frames) => {
    let sum = 0
    let expected = 0
    for (let i = 0; i < frames; i += 1) {
      put(metres)
      game.update(1 / 60)
      const now = lampReadout(game)
      sum += now.keys[0].intensity
      expected += 400 * beast.lampDread(now.dread.distance, game.animTime, { seed })
    }
    return { mean: sum / frames, expected: expected / frames, metres }
  }
  // The creature is RE-PINNED every frame — during a whole second of simulation §6.1's
  // chase state walks it down the road toward the player, out of the radius and on, so a
  // version that pinned once was measuring "a creature that leaves" rather than the ramp.
  //
  // The three ends are the RAMP, not the radius: `LAMP_DREAD_FADE` 6 m of it, so 0 m and
  // 3 m are both at full weight and would sample the same distribution twice. 9 m is the
  // ramp's midpoint, where the weight is a half.
  const underIt = sample(0, 240)
  const rampMid = sample(beast.LAMP_DREAD_RADIUS - beast.LAMP_DREAD_FADE / 2, 240)
  const outside = sample(beast.LAMP_DREAD_RADIUS + 6, 240)
  for (const [label, at] of [['under it', underIt], ['mid-ramp', rampMid], ['outside', outside]]) {
    assert.ok(
      Math.abs(at.mean - at.expected) < 1e-6,
      `the ${label} lamp (${at.metres} m) averages ${at.mean.toFixed(4)} where the pure function at the same frames averages ${at.expected.toFixed(4)}`,
    )
  }
  assert.ok(underIt.mean < rampMid.mean, `the lamp is ${underIt.mean.toFixed(1)} with the creature under it and ${rampMid.mean.toFixed(1)} at the ramp's midpoint`)
  assert.ok(rampMid.mean < outside.mean, `the lamp is ${rampMid.mean.toFixed(1)} at the ramp's midpoint and ${outside.mean.toFixed(1)} past the radius`)
  assert.ok(outside.mean > 399, `a lamp with nothing under it averages ${outside.mean.toFixed(1)} of 400`)
  assert.ok(underIt.mean < 400 * 0.8, `a lamp with the creature standing under it averages ${underIt.mean.toFixed(1)} of 400, which is not a drodd`)
  console.log(
    `\n  pass-11 lamps: lamp 0 under the creature ranged ${lowest.toFixed(2)}-${highest.toFixed(2)} of 400 over 4 s, ` +
      `the other ${others.length} lit lamp(s) untouched, ${underIt.mean.toFixed(0)}/${rampMid.mean.toFixed(0)}/${outside.mean.toFixed(0)} of 400 ` +
      `at 0 m, ${atRadius / 2} m and ${beast.LAMP_DREAD_RADIUS + 6} m, equal to the pure level on every frame`,
  )
})

check('pass-11: the eye flare pulses the lamp once, and only while it is flaring', () => {
  // THE SAME SPOT PROBE pass 10's flare check uses, and it is copied rather than shared
  // because each harness block is a self-contained story; the mechanic it searches for is
  // a §6.3 sighting — in range, inside the cone, not behind a house — and the search is
  // over bearings and ranges rather than a hand-picked pair, with a guard that the
  // placement EXISTS. A check that cannot fire is the pass-10 review's complaint about
  // the trail all over again.
  game.restart()
  game.start()
  run(game, 1.6)
  const player = { x: game.player.pos.x, z: game.player.pos.z }
  const range = beast.detectionRange(0, 0)
  const origin = game.streetView.origin
  let placed = null
  for (const dz of [3, 4, 5, 6, -3, -4, -5, -6]) {
    for (const dx of [0, 1, -1, 2, -2]) {
      const canonical = { x: hood.canonicalCoord(player.x) + dx, z: hood.canonicalCoord(player.z) + dz }
      const drawn = { x: canonical.x + origin.x, z: canonical.z + origin.z }
      if (!beast.canSee(drawn, { x: player.x, z: player.z }, { range, occluders: game.streetView.occluders() })) continue
      placed = { dx, dz, canonical }
      break
    }
    if (placed) break
  }
  assert.ok(placed, 'no placement within 6 m of the player is a §6.3 sighting, so this check can never fire')
  // ...AND THE PLACEMENT HAS TO BE UNDER A LAMP, because the brief said "nearby lamp
  // glow" and a pulse on a lamp the creature is not near is a lie about the light's
  // source. The check searches for a placement that satisfies BOTH, and says so when it
  // cannot find one rather than quietly testing a lamp on the far side of the street.
  const aimed = game.streetView.lampsNear(player.x, player.z, 96)
  let underLamp = null
  for (const lamp of aimed) {
    for (const dx of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      for (const dz of [2, 3, 4, 5, 6, 7, 8, -3, -4, -5]) {
        const world = { x: lamp.x + dx, z: lamp.z + dz }
        if (Math.hypot(world.x - player.x, world.z - player.z) > range) continue
        const canonical = { x: hood.canonicalCoord(world.x), z: hood.canonicalCoord(world.z) }
        const drawn = { x: canonical.x + origin.x, z: canonical.z + origin.z }
        if (!beast.canSee(drawn, { x: player.x, z: player.z }, { range, occluders: game.streetView.occluders() })) continue
        if (Math.hypot(drawn.x - lamp.x, drawn.z - lamp.z) > beast.LAMP_DREAD_RADIUS) continue
        underLamp = { canonical, lamp }
        break
      }
      if (underLamp) break
    }
    if (underLamp) break
  }
  assert.ok(underLamp, `no §6.3 sighting is within ${beast.LAMP_DREAD_RADIUS} m of a lit lamp, so the lamp cannot pulse`)
  // FILL THE METER until §6.2 crosses 1.0 and the state machine turns it into a chase,
  // taking the FIRST frame the world says so. The position is re-pinned every frame for
  // §11.1's reason: at three metres the creature reaches the player and captures inside
  // two seconds, which is four before the meter fills.
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0.6 })
  game.creaturePosition = underLamp.canonical
  const slot = game.streetView.lampsNear(game.player.pos.x, game.player.pos.z, 96).findIndex((l) => Math.abs(l.x - underLamp.lamp.x) < 1e-6 && Math.abs(l.z - underLamp.lamp.z) < 1e-6)
  assert.ok(slot >= 0, 'the lamp under the creature is not in the pool the world drives')
  let spot = null
  for (let frame = 0; frame < 900; frame += 1) {
    game.creaturePosition = underLamp.canonical
    game.update(DT)
    if (game.creature.state !== 'chase') continue
    const now = lampReadout(game)
    spot = { frame, intensity: now.keys[slot].intensity, pulse: now.dread.pulse, level: now.dread.level, flare: game.creatureView.pose.eyeFlare }
    break
  }
  assert.ok(spot, 'the creature never reached a chase from a sighting under a lamp, so nothing pulsed')
  // THE PULSE IS ON THE BUILT LIGHT, at the documented gain, on the spotting frame.
  assert.equal(spot.pulse, 1 + beast.LAMP_PULSE_GAIN, `the lamp's pulse envelope is ${spot.pulse} on the spotting frame`)
  const expected = 400 * spot.level * spot.pulse
  assert.ok(
    Math.abs(spot.intensity - expected) < 1e-6,
    `the built light is at ${spot.intensity.toFixed(2)} and 400 x ${spot.level.toFixed(4)} x ${spot.pulse} is ${expected.toFixed(2)}`,
  )
  // ...and it SURGES relative to the same lamp on a non-flaring frame. The comparison is
  // against the level this very frame drodded to, not against the base, because the two
  // terms are multiplied and a pulse measured against the base would read as smaller than
  // it is whenever a dropout lands under the flare.
  const quiet = 400 * spot.level
  assert.ok(spot.intensity > quiet * 1.4, `the lamp is at ${spot.intensity.toFixed(1)} against ${quiet.toFixed(1)} un-pulsed, which is not a pulse`)
  // AND IT IS ONE PULSE: the envelope is back to exactly 1 within the window and stays
  // there, which is what "a single deterministic pulse" means against a lamp that is
  // still drodded rather than against a lamp that has recovered.
  let returned = null
  for (let frame = 0; frame < 200; frame += 1) {
    game.creaturePosition = underLamp.canonical
    run(game, 1 / 60)
    if (lampReadout(game).dread.pulse === 1) { returned = frame; break }
  }
  assert.ok(returned !== null, 'the lamp never stopped pulsing')
  assert.ok(
    returned * DT <= beast.EYE_FLARE_SECONDS + DT * 2,
    `the lamp was still pulsing ${((returned * DT) * 1000).toFixed(0)} ms after the sighting, and the window is ${(beast.EYE_FLARE_SECONDS * 1000).toFixed(0)} ms`,
  )
  // ...and it does not come back. A lamp that swelled once per sighting and never settled
  // would be a lamp with a memory, and the world clears the spot clock on every frame
  // the creature is not pursuing.
  const settled = lampReadout(game)
  assert.equal(settled.dread.pulse, 1, 'the lamp is still pulsing on a frame with no sighting')
  // AND A LAMP THE CREATURE IS NOT NEAR DOES NOT PULSE, which is the "nearby" half and
  // the one a whole-street version of this effect would fail.
  game.creaturePosition = { x: hood.canonicalCoord(underLamp.lamp.x) + 40, z: hood.canonicalCoord(underLamp.lamp.z) }
  game.spotElapsed = 0
  game.update(DT)
  const far = lampReadout(game)
  assert.ok(far.dread.pulse > 1, 'the pulse needs a sighting to exist')
  assert.equal(far.keys[slot].intensity, 400, `a lamp 40 m away pulsed to ${far.keys[slot].intensity}`)
  console.log(
    `\n  pass-11 pulse: lamp slot ${slot} surged to ${spot.intensity.toFixed(1)} from ${quiet.toFixed(1)} on the sighting frame ` +
      `(${((spot.intensity / quiet - 1) * 100).toFixed(0)}% on top of the drodd), settled after ${(returned * DT * 1000).toFixed(0)} ms of a ` +
      `${(beast.EYE_FLARE_SECONDS * 1000).toFixed(0)} ms window, and did not move for a lamp 40 m away`,
  )
})
check('pass-11 review: the lamp record is a measurement on every frame, including the two quiet phases', () => {
  // §9.3's black and §10.4's card are the only two places `_updateCreatureView` calls
  // `_writeLampDread(null)`, and they are the only two places the sodium family is
  // supposed to be flat. That part was right. The FOURTH published number was not:
  // `distance` was `Infinity` for the whole of both phases, on a field whose own
  // docblock promises it is "finite on EVERY frame", and `nearness` reads a
  // non-finite distance as ZERO. So the record said "directly under the lamp" for a
  // lamp with a dormant creature 13 m away, and the lamp-dread wiring check above —
  // which is the check that exists to catch exactly this — samples only frames where a
  // creature is present, and so never saw it.
  //
  // THE PROPERTY, STATED AS A GATE RATHER THAN A MEASUREMENT. "Finite" on its own is
  // nearly decorative: a sentinel like -1 or 1e9 is finite and inverts just as quietly.
  // What actually distinguishes a measurement from a sentinel is that it MOVES when
  // the thing being measured moves, so the claims below are, in order:
  //
  //   1. finite, on every sampled frame rather than only the frame the phase began on;
  //   2. RESPONSIVE — walk the creature 40 m and the published distance has to change,
  //      which `Infinity` cannot do, because there is no arithmetic on it to do;
  //   3. CORRECT — the published number is the distance from the creature's canonical
  //      position to the nearest lamp the world actually aimed at, computed here from
  //      the world's own list so the check cannot inherit the bug it is looking for;
  //   4. and it READS BACK as "nothing near it", which is the half the bug was in.
  const phases = [
    { label: '§9.3 reset', enter: (world) => {
        world.state = { ...world.state, hammerHeld: true }
        world.creature = beast.createCreature({ state: 'chase', awareness: 1 })
        placeCreature(world, 0)
        world.update(DT)
        assert.equal(world.store.get().phase, PHASE.RESET, 'the capture did not reset')
      } },
    { label: '§10.4 win', enter: (world) => {
        const anchor = world.streetView.worldOf(world.state.exitAnchor.position)
        world.player.teleport(anchor.x, anchor.z, 0)
        world.state = { ...world.state, finale: true }
        world.update(DT)
        assert.equal(world.store.get().phase, PHASE.WON, 'walking into the exit did not win')
      } },
  ]
  // The distance the world SHOULD publish, from the world's own aimed list. The fold is
  // `worldOf`, deliberately not taken out of `_writeLampDread`, or the check would agree
  // with the bug by construction.
  const truth = (world) => {
    const here = world.streetView.worldOf(world.creaturePosition)
    let nearest = Infinity
    for (let i = 0; i < world.lampLights.length; i += 1) {
      const light = world.lampLights[i]
      const lamp = world._lampAimed?.[i]
      if (!light || !light.visible || !lamp) continue
      nearest = Math.min(nearest, Math.hypot(here.x - lamp.x, here.z - lamp.z))
    }
    return nearest
  }
  const seedFor = (world) => beast.lampDreadSeed(world.seed, 0)
  for (const { label, enter } of phases) {
    game.restart()
    game.start()
    run(game, 1.6)
    // The same placement the strobe check uses, and for the same reason: the lit lamps
    // are the nearest to the PLAYER, so "the lamp this creature is under" has to be
    // asked of the world's own aimed list rather than assumed.
    const aimed = game.streetView.lampsNear(game.player.pos.x, game.player.pos.z, 96)
    assert.ok(aimed.length > 0, `${label}: the light pool has no lamps in it, so this check can never fire`)
    const lamp = aimed[0]
    game.creaturePosition = { x: hood.canonicalCoord(lamp.x + 1), z: hood.canonicalCoord(lamp.z) }
    // A creature UNDER a lamp on the way in, so the record has a drodd to lose. If this
    // check only ever entered the quiet phases from a clean street it would not know
    // whether the fix reset the field or merely never filled it.
    game.creature = beast.createCreature({ state: 'chase', awareness: 1 })
    game.update(DT)
    const before = lampReadout(game)
    assert.ok(before.dread.level < 1, `${label}: nothing was drodded on the way in, so there is nothing to lose`)
    enter(game)
    // ...and the lights must be back at their base, because that is the property the
    // fix has to leave completely alone. Measured here so that a "fix" which also made
    // the quiet phases quiet *because* it stopped reporting, rather than because it
    // reports correctly, cannot pass.
    const bases = lampReadout(game)
    for (const key of bases.keys) {
      if (key.visible) assert.equal(key.intensity, 400, `${label}: a lamp is at ${key.intensity} and the card is supposed to be quiet`)
    }
    // 1. FINITE, every sampled frame, not just the frame the phase was entered on.
    for (let frame = 0; frame < 240; frame += 1) {
      game.update(DT)
      const now = lampReadout(game)
      assert.ok(
        Number.isFinite(now.dread.distance),
        `${label} frame ${frame}: the record published ${now.dread.distance} m, and a non-finite distance reads as "under the lamp"`,
      )
    }
    // 2. RESPONSIVE, and deliberately NOT "moving away makes it larger": this is a
    //    repeating grid of blocks, and the assertion that the record grows when the
    //    creature walks `+z` is false on a real street — 40 m north of one lamp is 24 m
    //    from the next. What separates a measurement from a sentinel is that it CHANGES
    //    at all, in whichever direction the street dictates, and the pre-fix world
    //    answers the same `Infinity` on both sides of the move.
    const standing = lampReadout(game)
    // ...so the spot is searched for rather than assumed: a place the world's own aimed
    // list says is far enough from EVERY lamp that "no dread at all" is the true reading.
    let spot = null
    for (const dz of [40, -40, 70, -70, 110, -110]) {
      for (const dx of [0, 25, -25, 55, -55]) {
        game.creaturePosition = { x: hood.canonicalCoord(lamp.x + 1 + dx), z: hood.canonicalCoord(lamp.z + dz) }
        if (truth(game) > beast.LAMP_DREAD_RADIUS + 6) { spot = { dx, dz }; break }
      }
      if (spot) break
    }
    assert.ok(spot, `${label}: no placement within 110 m of the lamp is clear of the dread radius, so this check can never fire`)
    game.update(DT)
    const after = lampReadout(game)
    assert.ok(
      Math.abs(after.dread.distance - standing.dread.distance) > 10,
      `${label}: walking the creature ${spot.dx} m / ${spot.dz} m moved the published distance only ` +
        `${standing.dread.distance} -> ${after.dread.distance}, so the record is a constant rather than a measurement`,
    )
    // 3. CORRECT, against the world's own aimed list. Ten centimetres of slack, because
    //    this is a second fold of the same canonical position and a fold is float work.
    const expected = truth(game)
    assert.ok(
      Math.abs(after.dread.distance - expected) < 0.1,
      `${label}: the record says ${after.dread.distance.toFixed(3)} m and the nearest aimed lamp is ${expected.toFixed(3)} m away`,
    )
    // 4. AND THE HALF WITH THE BUG IN IT. Clear of the radius, nothing is near any lamp,
    //    so the honest reading of the record is "no dread at all" — and `Infinity` through
    //    `lampDread` is a full one. That is the pre-fix answer, on purpose.
    const echoed = beast.lampDread(after.dread.distance, game.animTime, { seed: seedFor(game) })
    assert.equal(
      echoed,
      1,
      `${label}: the published ${after.dread.distance.toFixed(2)} m reads back as a drodd of ${echoed.toFixed(4)} on a frame with no figure at all`,
    )
    // 5. AND THE FLAT PART OF THE RECORD IS STILL FLAT, so nothing here has quietly
    //    turned the quiet phases into a strobe the lights happen not to show.
    assert.equal(after.dread.lamp, -1, `${label}: a lamp is recorded as drodded on a frame with no figure`)
    assert.equal(after.dread.level, 1, `${label}: the published level is ${after.dread.level} on a frame with no figure`)
    // 6. AND A LAMP CANNOT BE PULSED AT AN ABSENCE. This one is white-box on purpose.
    //    Every call site passes no `pose` when it passes no figure, so today the `near`
    //    term is `pulse` of 1 and the `drawn !== null` guard is an equivalent mutant —
    //    the version without it passes 94/94. It is kept because that guard is the only
    //    thing between a future caller that passes a pose and a lamp across the street
    //    swelling on the creature's behalf, and a check that cannot see that class of
    //    bug is a comment. §12.2's rule is that a light belongs to its source.
    //
    //    THE CREATURE GOES BACK UNDER THE LAMP FIRST, which is the whole difficulty: at
    //    the spot found above, `near` is false on the geometry alone and the guard is
    //    invisible. Put the creature 1 m from the lamp again and the un-guarded version
    //    surges the key to 580 of 400.
    game.creaturePosition = { x: hood.canonicalCoord(lamp.x + 1), z: hood.canonicalCoord(lamp.z) }
    const flaring = beast.creaturePose(beast.createCreature({ state: 'chase', awareness: 1 }), {
      time: game.animTime, distance: 2, sinceSpot: 0,
    })
    assert.ok(flaring.eyeFlare > 0.9, `the pose this check pulses a lamp with flares at ${flaring.eyeFlare}, so the mutation would be invisible`)
    game._writeLampDread(null, flaring)
    const ghosted = lampReadout(game)
    for (const key of ghosted.keys) {
      if (!key.visible) continue
      assert.equal(key.intensity, 400, `${label}: a lamp with no figure under it surged to ${key.intensity}`)
      if (key.bounceVisible) {
        assert.equal(key.bounce, 46, `${label}: the bounce under a lamp with no figure moved to ${key.bounce}`)
      }
    }
    console.log(
      `\n  pass-11 review ${label}: the record followed the creature ${standing.dread.distance.toFixed(1)} m -> ` +
        `${after.dread.distance.toFixed(1)} m on a frame with no figure, and reads back at ${echoed.toFixed(3)}; ` +
        `before the fix it published Infinity on all 240 frames, which lampDread reads as a full drodd`,
    )
  }
})



check('pass-12: the near field reaches the built swirl, is continuous, and closes when you turn away', () => {
  game.restart()
  run(game, 0.5)
  const street = game.streetView
  const portal = street.portals[0]

  // 1. AT RANGE the swirl turns at the table's own rate. 30 m is outside
  //    `PORTAL_NEAR_METRES` (8), so nearness is 0 and the multiplier is 1. The
  //    check reads the BUILT rotation and compares against the table read out of the
  //    source, so a retune of the table has to move both and a retune of the near
  //    field cannot hide here.
  standAtPortal(portal, 30)
  const far = portal.swirl.map((layer) => layer.rotation.z)
  run(game, 0.5)
  const farDelta = portal.swirl.map((layer, i) => layer.rotation.z - far[i])
  for (const [i, delta] of farDelta.entries()) {
    const expected = IDLE_SWIRL_RATES[i] * 0.5
    assert.ok(
      Math.abs(delta - expected) < 1e-9,
      `${portal.id}'s layer ${i} turned ${delta.toFixed(6)} rad in 0.5 s from 30 m, against the table's ${expected.toFixed(6)} — the near field is reaching across the map, or is not off at all`,
    )
  }

  // 2. AT THE DOOR, facing it, the swirl turns faster — measurably, and still under
  //    the pass-3 ceiling, which is the constraint that forced `PORTAL_NEAR_SPIN`
  //    down from 2.2 to 1.6.
  standAtPortal(portal, 2.2)
  const near0 = portal.swirl.map((layer) => layer.rotation.z)
  run(game, 0.5)
  const nearDelta = portal.swirl.map((layer, i) => layer.rotation.z - near0[i])
  for (const [i, delta] of nearDelta.entries()) {
    assert.ok(
      Math.abs(delta) > Math.abs(farDelta[i]) * 1.2,
      `${portal.id}'s layer ${i} turned ${delta.toFixed(5)} rad at the door against ${farDelta[i].toFixed(5)} at 30 m — the near field is not reaching the built scene`,
    )
    assert.ok(
      Math.abs(delta) / 0.5 < 0.35,
      `${portal.id}'s layer ${i} turns at ${(Math.abs(delta) / 0.5).toFixed(3)} rad/s at the door, over the 0.35 ceiling pass 3 wrote`,
    )
  }

  // 3. **AND IT IS CONTINUOUS IN THE PLAYER'S POSITION — which is the check this
  //    pass exists to have, because the first version of the near field was
  //    `rotation.z = t * rate` and that is a DISCONTINUITY of `t * d(rate)`.**
  //    Teleporting the player across the 8 m boundary used to move the arms by
  //    eighteen radians on a single frame, which is the effect teleporting rather
  //    than accelerating. The bound below is the one that distinguishes them: over
  //    one frame the angle can move by at most `maxRate * dt`, whatever the player
  //    did, and a product form breaks that by orders of magnitude at any `t` worth
  //    the name. It is asserted on a LARGE jump on purpose — the failure mode is
  //    invisible on a small one, and a check that only walks one metre cannot tell
  //    a ramp from a cliff.
  const before = portal.swirl.map((layer) => layer.rotation.z)
  standAtPortal(portal, 30)
  const step = portal.swirl.map((layer, i) => Math.abs(layer.rotation.z - before[i]))
  for (const [i, jumped] of step.entries()) {
    const ceiling = Math.max(...IDLE_SWIRL_RATES.map(Math.abs)) * rules.PORTAL_NEAR_SPIN * DT
    assert.ok(
      jumped <= ceiling + 1e-9,
      `${portal.id}'s layer ${i} jumped ${jumped.toFixed(4)} rad in one frame when the player crossed the near field; one frame can move it at most ${ceiling.toFixed(4)} — the rate is being multiplied by the clock instead of integrated`,
    )
  }

  // 4. AND IT GOES AWAY WHEN THE PLAYER TURNS AROUND, at the same distance. This is
  //    the facing gate, and it is the half a distance-only check cannot see: the
  //    two cases differ in one number and nothing else, so a bearing wired to the
  //    wrong vector — or to a stale one — shows up here and nowhere else.
  standAtPortal(portal, 2.2)
  run(game, 0.2)
  game.player.yaw += Math.PI
  // TWO frames, not one, and the reason is worth writing down: `world.update`
  // hands the view the camera as it stood when the frame STARTED, so the turn
  // reaches the near field one frame late by construction. One frame of settling is
  // the integration's own quantisation; the difference it makes is `0.6 * DT`, and
  // the assertion below has a tolerance for exactly that and no more.
  game.update(DT)
  game.update(DT)
  const away0 = portal.swirl.map((layer) => layer.rotation.z)
  run(game, 0.5)
  const awayDelta = portal.swirl.map((layer, i) => layer.rotation.z - away0[i])
  for (const [i, delta] of awayDelta.entries()) {
    // the settled rate must be back to the table, to within one frame of the
    // largest step the near field could have contributed on the settling frame
    const tolerance = Math.abs(IDLE_SWIRL_RATES[i] * rules.PORTAL_NEAR_SPIN * DT)
    assert.ok(
      Math.abs(delta - farDelta[i]) <= tolerance,
      `${portal.id}'s layer ${i} turned ${delta.toFixed(6)} rad in 0.5 s with the player 2.2 m away and their back to it, against the table's ${farDelta[i].toFixed(6)} — the facing gate is not closing`,
    )
  }

  // 5. AND IT IS REPRODUCIBLE FROM A FRESH RUN, which is the claim an integral has
  //    to be judged on and the one a naive version of this check gets wrong. An
  //    integral's absolute value depends on the whole history that produced it, so
  //    standing at the same door twice inside one run and comparing the ANGLES is
  //    meaningless — the second stand-off is reached with a different accumulated
  //    time behind it, and the first version of this check compared them and
  //    reported the difference as though it were a failure. What is reproducible is
  //    the whole trajectory, and that means restarting.
  //
  //    This is exactly the property §16.5 needs: `capture.js` restarts, steps a
  //    fixed sequence at a fixed `SIM_DT`, and photographs the result, so two runs
  //    of the same script have to land on the same rotation. A version that kept a
  //    frame COUNT would pass 1, 2, 3 and 4 and fail this, which is the whole
  //    reason the check is here rather than folded into the one above.
  const script = () => {
    game.restart()
    run(game, 0.5)
    const p = game.streetView.portals[0]
    standAtPortal(p, 2.2)
    run(game, 0.5)
    return p.swirl.map((layer) => layer.rotation.z)
  }
  const once = script()
  const twice = script()
  for (const [i, value] of twice.entries()) {
    assert.equal(value, once[i], `${portal.id}'s layer ${i} is at ${value} on a second identical run and ${once[i]} on the first — the swirl is not reproducible`)
  }
})

check('pass-12: the debris ring is in the built frame, and every rock is outside the hole', () => {
  game.restart()
  run(game, 0.5)
  const street = game.streetView
  const portal = street.portals[0]
  // The §16.5.6 stand-off, which is the closest a capture gets and so the frame
  // where a rock is biggest and the pupil is nearest.
  standAtPortal(portal, 2.2)
  run(game, 0.6)
  game.scene.updateMatrixWorld(true)

  // 1. THE RING IS BUILT AND DRAWN, at the documented count and no more. Read off
  //    the mesh rather than off `rules`, so a count that was set to zero fails here
  //    instead of quietly drawing nothing.
  assert.ok(portal.debris.isInstancedMesh, `${portal.id}'s debris is not an InstancedMesh`)
  assert.ok(portal.debris.count > 0, `${portal.id}'s ring has a count of ${portal.debris.count} — it is built and draws nothing`)
  assert.ok(portal.debris.count <= rules.PORTAL_DEBRIS_MAX, `${portal.id} draws ${portal.debris.count} rocks, over the ${rules.PORTAL_DEBRIS_MAX} cap`)
  assert.equal(portal.debris.parent, portal.gate, `${portal.id}'s ring is not in its own gate, so it is not in the world`)

  // 2. **AND EVERY ROCK IS PROJECTED INSIDE THE FRAME.** This is pass 10's finding
  //    answered for a ring: a feature that exists, is pure, is deterministic and is
  //    in no picture is a feature nobody will ever look at. The matrices come out of
  //    the built `instanceMatrix` and go through the real camera, so a wrong pose
  //    cannot pass by being correct in the pure module.
  //
  //    THE PUPIL HALF IS IN THE GATE'S OWN FRAME, and that is a correction rather
  //    than a convenience. The first version compared each rock's WORLD position
  //    with the gate's WORLD position, which is the same measurement with a 448 m
  //    period folded into it — the gate sits at its own lot and the rocks sit on the
  //    gate, so the two are coincident only after the fold, which is the same class
  //    of bug pass 11's review found four times in `_walkCreature`. The inverse of
  //    the gate's world matrix puts both in one frame, where "the centre" means it.
  const camera = game.camera
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
  const coreRadius = 0.72 * portal.gateScale
  const positions = []
  let inside = 0
  for (let i = 0; i < portal.debris.count; i += 1) {
    const matrix = new THREE.Matrix4()
    portal.debris.getMatrixAt(i, matrix)
    const local = new THREE.Vector3().setFromMatrixPosition(matrix)
    positions.push(local.clone())
    const radius = Math.hypot(local.x, local.y)
    assert.ok(
      radius > coreRadius,
      `rock ${i} of ${portal.id} is at ${radius.toFixed(3)} m of the gate's centre on a ${coreRadius.toFixed(3)} m hole — it is inside the pupil`,
    )
    // ...and the flake is a REGULAR TETRAHEDRON, because the squash is on the orbit
    // and not on the mesh. A uniform scale is what keeps it one.
    //
    // THE TOLERANCE IS RELATIVE, and it has to be: `InstancedMesh.instanceMatrix`
    // is a `Float32Array`, so a 0.0384 scale comes back with about seven
    // significant digits and an absolute epsilon of 1e-9 compares two numbers that
    // are visibly identical and are not. `max * 1e-5` is the right shape for a
    // float32 — relative to the magnitude being compared, not to zero.
    const scale = new THREE.Vector3().setFromMatrixScale(matrix)
    const spread = Math.max(scale.x, scale.y, scale.z) * 1e-5
    assert.ok(
      Math.abs(scale.x - scale.y) <= spread && Math.abs(scale.y - scale.z) <= spread,
      `rock ${i} of ${portal.id} is scaled (${scale.x.toFixed(6)}, ${scale.y.toFixed(6)}, ${scale.z.toFixed(6)}) — a squashed tetra is a different solid`,
    )
    const projected = local.clone().applyMatrix4(portal.gate.matrixWorld).project(camera)
    if (Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z < 1) inside += 1
  }
  assert.ok(
    inside >= portal.debris.count * 0.8,
    `only ${inside} of ${portal.debris.count} rocks on ${portal.id} project inside the 1280x720 frame at the §16.5.6 stand-off — the ring is in the scene and not in the picture`,
  )
  // 3. AND THE ROCKS ARE DARK ENOUGH TO STAY OUT OF THE EYE FINDER, measured on the
  //    built material rather than on the constant the pure module exports — the
  //    constant and the material are two places the same colour lives, and only one
  //    of them is what gets drawn.
  assert.equal(portal.debris.material.color.getHex(), rules.PORTAL_DEBRIS_COLOUR, `${portal.id}'s rocks are not the colour the pure module's eye-span argument was written about`)
  assert.ok(
    materialLuma(portal.debris.material) < 128,
    `${portal.id}'s rocks are ${materialLuma(portal.debris.material).toFixed(0)} luma as a swatch — bright enough for the eye finder to consider`,
  )
  // ...and it is a LIT material, which is the one thing `_glow` cannot be, because
  // the brief asks for rocks that "catch the rim light" and an unlit material
  // catches nothing.
  assert.notEqual(portal.debris.material.type, 'MeshBasicMaterial', `${portal.id}'s rocks are unlit, so they cannot catch the portal's own light`)
  // and the light they catch is really there: the portal's own point light, inside
  // the same root, which is the whole reason the ring is in the gate rather than out
  // in the world where the gate's transform would not reach it
  assert.equal(portal.light.parent, portal.root, `${portal.id}'s ring has no light to catch`)
  assert.ok(portal.light.intensity > 0, `${portal.id}'s light is out, so the rocks catch nothing`)

  // 4. AND THE RING TURNS, because a static ring of fourteen flakes is a necklace.
  //    Two samples a quarter of a second apart must differ, and each rock's distance
  //    from the gate's centre must be a CONSTANT — which is what proves a rock moved
  //    along its orbit rather than grew away from it.
  run(game, 0.25)
  let moved = 0
  for (let i = 0; i < portal.debris.count; i += 1) {
    const matrix = new THREE.Matrix4()
    portal.debris.getMatrixAt(i, matrix)
    const now = new THREE.Vector3().setFromMatrixPosition(matrix)
    const before = Math.hypot(positions[i].x, positions[i].y)
    const after = Math.hypot(now.x, now.y)
    assert.ok(
      Math.abs(after - before) < 1e-6,
      `rock ${i} of ${portal.id} changed radius, from ${before.toFixed(6)} to ${after.toFixed(6)} — it left its orbit rather than turning on it`,
    )
    if (now.distanceTo(positions[i]) > 1e-6) moved += 1
  }
  assert.ok(moved > portal.debris.count * 0.5, `only ${moved} of ${portal.debris.count} rocks on ${portal.id} moved in a quarter of a second`)

  // 5. AND §5.3 PUTS THE RING OUT WITH THE HOLE, because a ring of lit flakes
  //    orbiting a dead portal is neither cold nor inert.
  assert.equal(street.setPortalShut(portal.id, true), true)
  assert.equal(portal.debris.visible, false, `${portal.id}'s ring is still orbiting a shut hole`)
  assert.equal(portal.lens.visible, false, `${portal.id}'s lens is still there over a shut hole`)
})

check('pass-12: the collapse runs for 0.8 s, and §5.3 holds on the frame it starts', () => {
  game.restart()
  run(game, 0.5)
  const street = game.streetView
  const portal = street.portals[0]
  standAtPortal(portal, 2.2)
  run(game, 0.3)

  // 1. **§5.3, ON THE EXACT FRAME.** The hold completes and `setPortalShut`
  //    returns; the live gate has to be dead on THAT frame and not one frame
  //    later. This is the assertion the whole "a second aperture over a dead one"
  //    design exists to satisfy, and it is the first thing in the repository to
  //    read the materials on the frame rather than a frame later.
  assert.equal(street.setPortalShut(portal.id, true), true)
  assert.equal(portal.rim.material, street._materials.portalDead, `${portal.id}'s lip is still lit on the frame it shut`)
  assert.equal(portal.disc.material, street._materials.portalCoreDead, `${portal.id}'s hole is still live on the frame it shut`)
  assert.ok(portal.swirl.every((layer) => layer.visible === false), `${portal.id}'s swirl is still turning on the frame it shut`)
  assert.equal(portal.light.intensity, 0, `${portal.id}'s light is still on on the frame it shut`)
  // ...and the collapse is armed, visible, and at FULL SIZE on that same frame — the
  // aperture has not started closing, so what the player sees in the first frame of
  // the aftermath is a full-size bright hole and not a half-open one.
  assert.ok(portal.collapse.visible, `${portal.id}'s collapse is not showing on the frame it armed`)
  assert.ok(Math.abs(portal.collapse.scale.x - 1) < 1e-6, `${portal.id}'s collapse opens at ${portal.collapse.scale.x.toFixed(4)} rather than at full size`)
  assert.equal(portal.collapseAt, street._time, `${portal.id}'s collapse clock was not stamped from the view's own clock`)
  // ...and it is a SEPARATE aperture, not the live one: the group is not the gate,
  // and the disc behind it is the dead material while the group's own core is the
  // LIVE colour, which is the whole "a hole closing over a hole" read.
  assert.notEqual(portal.collapse, portal.gate, `${portal.id}'s collapse IS the live gate, so §5.3 is a lie for 0.8 s`)
  //
  // AND THE COLOUR IS COMPARED TO THE MATERIALS RATHER THAN TO A LITERAL. A first
  // version wrote `0x04100f` here and it failed with `331022 !== 266255`: three.js
  // holds a `Color` in LINEAR components and `getHex()` encodes them back to sRGB,
  // so a hand-typed palette hex is the wrong side of a conversion. Comparing the
  // collapse's own core to the two materials it is supposed to be between is both
  // correct in the renderer's colour space and a stronger claim, because it says
  // "the LIVE one, not the DEAD one" rather than "a number I remembered".
  const liveCore = street._materials.portalCore.color.getHex()
  const deadCore = street._materials.portalCoreDead.color.getHex()
  assert.notEqual(liveCore, deadCore, 'the two core materials are the same colour, so this check cannot distinguish them')
  assert.equal(portal.collapseCore.material.color.getHex(), liveCore, `${portal.id}'s collapse does not start from the live core colour`)
  assert.notEqual(portal.collapseCore.material.color.getHex(), deadCore, `${portal.id}'s collapse starts from the DEAD core colour, so nothing is seen to close`)

  // 2. IT IS TIMED, and 0.8 s is the number the pass claims. Sampled at the end of
  //    the collapse rather than at the middle, so a too-short animation cannot pass
  //    by being caught at a moment it happens to look right.
  const before = portal.collapse.scale.x
  run(game, rules.PORTAL_COLLAPSE.seconds * 0.4)
  const mid = portal.collapse.scale.x
  assert.ok(mid < before, `${portal.id}'s collapse did not close in its first 40%`)
  assert.ok(mid > 0.9, `${portal.id}'s collapse is at ${mid.toFixed(3)} after 40% of its own duration — the ease is not holding`)
  run(game, rules.PORTAL_COLLAPSE.seconds * 0.6)
  assert.equal(portal.collapse.visible, false, `${portal.id}'s collapse is still on screen after its own duration`)
  assert.equal(portal.collapse.scale.x, 0, `${portal.id}'s collapse is scaled to ${portal.collapse.scale.x} at the end`)

  // 3. AND IT DOES NOT COME BACK, which is the difference between an animation and
  //    a mode. A second and a half later the group is still hidden and still at
  //    zero — a collapse keyed on `shut` rather than on `collapseAt` would be
  //    re-scaling a dead hole for ever, and that is the mutation this guards.
  run(game, 1.5)
  assert.equal(portal.collapse.visible, false, `${portal.id}'s collapse came back a second and a half after it ended`)
  assert.equal(portal.collapse.scale.x, 0)

  // 4. AND THE LIVE GATE NEVER MOVED THROUGH ANY OF IT, which is §5.3's silence
  //    stated as a measurement rather than as a material.
  const dead = portal.swirl.map((layer) => layer.rotation.z)
  run(game, 1.0)
  for (const [i, layer] of portal.swirl.entries()) {
    assert.equal(layer.rotation.z, dead[i], `${portal.id}'s layer ${i} turned after the hole was shut`)
  }

  // 5. AND A RE-SHUT RESTARTS IT, so the collapse is not a one-shot a second
  //    shutdown cannot re-arm. The un-shut branch has to clear `collapseAt` as well
  //    as `visible`, and a `collapseAt` left stamped is a hole that collapses again
  //    every frame for ever.
  assert.equal(street.setPortalShut(portal.id, false), true)
  assert.equal(portal.collapseAt, null, `${portal.id}'s collapse clock survived an un-shut`)
  assert.equal(portal.collapse.visible, false)
  assert.ok(portal.swirl.every((layer) => layer.visible === true), `${portal.id}'s swirl did not come back with the hole`)
  run(game, 0.5)
  assert.equal(portal.collapse.visible, false, `${portal.id}'s collapse re-armed without a shutdown`)
  assert.equal(street.setPortalShut(portal.id, true), true)
  run(game, rules.PORTAL_COLLAPSE.seconds + 0.2)
  assert.equal(portal.collapse.visible, false, `${portal.id}'s second collapse did not finish`)

  // 6. AND THE FLASH IS LIT FOR EXACTLY ITS WINDOW, measured on the built
  //    material's opacity rather than on the pure function. A flash that never goes
  //    out is a strobe, and §14.3's reduced-motion rule exists because of exactly
  //    that; a flash that is never on is a feature nothing can see.
  const opacities = []
  assert.equal(street.setPortalShut(portal.id, false), true)
  assert.equal(street.setPortalShut(portal.id, true), true)
  const steps = Math.ceil((rules.PORTAL_COLLAPSE.seconds * 2) / DT)
  for (let i = 0; i < steps; i += 1) {
    game.update(DT)
    opacities.push(portal.collapseFlash.material.opacity)
  }
  const litFrames = opacities.filter((value) => value > 0).length * DT
  assert.ok(litFrames > 0, 'the flash was never lit — the collapse has a flash envelope and no flash')
  assert.ok(
    litFrames <= rules.PORTAL_COLLAPSE.flashWidth * 2 + DT,
    `the flash was lit for ${litFrames.toFixed(3)} s of a ${(rules.PORTAL_COLLAPSE.flashWidth * 2).toFixed(2)} s window`,
  )
  assert.equal(opacities[opacities.length - 1], 0, 'the flash is still lit after the collapse ended')
  assert.ok(Math.max(...opacities) <= 1, 'the flash opacity is above 1, which is not an opacity')
})

check('pass-12: the lens darkens the background near the rim and nothing else', () => {
  game.restart()
  run(game, 0.5)
  const street = game.streetView
  const portal = street.portals[0]

  // 1. IT IS BUILT AS AN OVERLAY, normal-blended, unfogged, and never writing depth
  //    — a quad that wrote depth would occlude the shell behind it and the
  //    "background" it is darkening would become the lens.
  assert.equal(portal.lens.geometry.type, 'CircleGeometry')
  assert.ok(
    portal.lens.geometry.parameters.radius > 0.72,
    `${portal.id}'s lens is ${portal.lens.geometry.parameters.radius} m across on a 0.72 m hole — it is not larger than the disc it lenses`,
  )
  assert.notEqual(portal.lens.material.blending, THREE.AdditiveBlending, `${portal.id}'s lens is additive, and an additive material can only ADD light to the pixel the pupil gate measures`)
  assert.equal(portal.lens.material.transparent, true)
  assert.equal(portal.lens.material.depthWrite, false, `${portal.id}'s lens writes depth, so it occludes the shell it is supposed to darken`)
  assert.equal(portal.lens.material.fog, false, `${portal.id}'s lens fogs, so the darkening is a function of distance rather than of radius`)
  assert.equal(portal.lens.parent, portal.gate, `${portal.id}'s lens is not in its own gate`)
  // ...and BEHIND the hole and its swirl. Behind is the load-bearing half: at z = 0
  // the lens was a larger, nearer solid target than the disc and became the first
  // hit of §16.1's stand-off raycast, which reported that a shell was in front of
  // its own opening. `PORTAL_LENS_DEPTH`'s docblock has the numbers.
  assert.ok(portal.lens.position.z < portal.disc.position.z, `${portal.id}'s lens is in front of its own hole, where a geometry test can see it`)
  for (const [i, layer] of portal.swirl.entries()) {
    assert.ok(portal.lens.position.z < layer.position.z, `${portal.id}'s lens is in front of swirl layer ${i}, so a normal-blended quad stands between the eye and the brightest thing in the aperture`)
  }

  // 2. **THE ALPHA RAMP, READ OFF THE BUILT TEXTURE.** The pure function's tests
  //    prove the profile; this proves the profile is what the renderer samples. The
  //    canvas here is a real one — the stub implements `createImageData`,
  //    `putImageData` and `getImageData` for exactly this reason — so the bytes
  //    below are the bytes three.js will read back at run time. `getImageData` on
  //    the SOURCE canvas is the only way to see them, because a `CanvasTexture`
  //    holds a GPU copy and nothing in this harness has a GPU.
  // THE BYTES COME OFF `canvas.pixels`, NOT OFF `getImageData`, and that is not a
  // preference. This harness's 2D stub implements `createImageData`,
  // `putImageData` and `getImageData`, and `getImageData` returns a FRESH ZEROED
  // buffer — a surface, not an implementation, per the stub's own header. Only
  // `putImageData` keeps what it was given, and it keeps it on `canvas.pixels`.
  //
  // So a first version that read through `getImageData` got 9216 zeros and every
  // alpha assertion below passed for the wrong reason — including the one at the
  // centre, which is the whole pupil claim. A green gate over a buffer of zeroes is
  // worse than a red one: it reports that the lens is zero on the hole, which is
  // true, and says nothing about whether it is zero for the right reason.
  const image = portal.lens.material.map.image
  const context = image.getContext('2d')
  const written = context.canvas.pixels
  assert.ok(written && written.data, 'the lens canvas retained nothing — `putImageData` did not keep its image, so nothing below can be measured')
  assert.equal(written.width, image.width, 'the retained lens buffer is a different size from the canvas')
  const pixels = written.data
  const half = (image.width - 1) / 2
  const alphaAt = (x, y) => pixels[(y * image.width + x) * 4 + 3]
  assert.equal(alphaAt(Math.round(half), Math.round(half)), 0, `the built lens texture has an alpha of ${alphaAt(Math.round(half), Math.round(half))} at its own centre — the profile is not zero on the hole`)
  // THE WHOLE DISC, not just the middle. This is the assertion that the
  // zero-for-every-radius-at-or-inside-1.0 claim survived being rasterised, and it
  // is the one a test sampling two points cannot make: a profile that is 0 at the
  // centre and 0.3 at three quarters of the radius passes every point sample and
  // fails here on the first texel that crosses.
  //
  // AND THIS SWEEP USES THE TEXTURE'S OWN MAPPING, which is a claim in itself. The
  // texel at offset `d` from the centre is at core-ratio `d * outer / half`, because
  // `CircleGeometry`'s UVs put the quad's rim at the edge of the texture square. A
  // first version of this sweep divided by `half` instead — the mapping the texture
  // BUILDER used before it was corrected — and therefore tested a disc 1.34x too
  // large, reporting a violation at ratio 0.992 for a texel that is at 1.329 and is
  // correctly transparent. A check that re-derives the geometry under test is a
  // second copy of it, and the two copies have to be written from the same sentence.
  const scale = rules.PORTAL_LENS.outer / half
  let insideDisc = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const ratio = Math.hypot(x - half, y - half) * scale
      if (ratio <= 1) {
        insideDisc += 1
        assert.equal(alphaAt(x, y), 0, `the built lens has alpha where it must have none, at ${ratio.toFixed(3)} of the radius`)
      }
    }
  }
  assert.ok(insideDisc > 1000, `only ${insideDisc} texels of the lens texture are inside the disc, so the sweep above barely sampled anything`)
  // ...and it DEEPENS toward the rim and vanishes at its own edge, both on the
  // built bytes: the same profile the pure function returns, read through a
  // rasteriser, which is the only version of the claim that a retune cannot make
  // true in one place and false in the other.
  const mid = Math.round(half)
  // THE RAMP IS THE RIGHT HALF OF THE ROW, and that is not a convenience. The
  // profile is symmetric, so a full row has its peak twice, and `indexOf` returns
  // the FIRST one — on the left, at a signed ratio of -1.11, which a check written
  // against a positive crest rejects for the right number at the wrong place. The
  // first version of this line scanned the whole row and reported the crest as
  // "-1.114 of the radius".
  const ramp = []
  for (let x = mid; x < image.width; x += 1) ramp.push(alphaAt(x, mid))
  const peak = Math.max(...ramp)
  assert.ok(peak > 0, 'the built lens texture is entirely transparent — the overlay darkens nothing')
  assert.ok(peak <= Math.ceil(rules.PORTAL_LENS.peak * 255), `the built lens peaks at ${(peak / 255).toFixed(3)} alpha against a declared ceiling of ${rules.PORTAL_LENS.peak}`)
  // `ramp` now starts at `mid`, so its index is an offset FROM the centre and not
  // a texel index. The two were conflated in a version that reported -0.240.
  const deepest = ramp.indexOf(peak)
  const ratioAtPeak = deepest * scale
  assert.ok(
    Math.abs(ratioAtPeak - rules.PORTAL_LENS.crest) < 0.06,
    `the built lens is deepest at ${ratioAtPeak.toFixed(3)} of the radius rather than at its declared crest of ${rules.PORTAL_LENS.crest}`,
  )
  // the outermost texel ring is the overlay's own edge, and it has to be clear
  assert.ok(alphaAt(image.width - 1, mid) === 0, 'the built lens has an edge of its own — a decal, not a haze')
  // and the profile RISES monotonically to the crest, sampled on the built bytes,
  // because a lens that deepens and then shallows before its crest is a lens with a
  // second ring in it and nothing in the pure gate would have said so
  for (let x = mid; x < mid + deepest - 1; x += 1) {
    assert.ok(alphaAt(x + 1, mid) >= alphaAt(x, mid), `the built lens does not deepen monotonically at ${((x - half) * scale).toFixed(3)} of the radius`)
  }

  // 3. AND IT IS ONE TEXTURE FOR ALL THREE PORTALS, which is the cheap version of
  //    the claim: a per-portal canvas is three 96x96 uploads for a profile that is
  //    a pure function of the radius.
  for (const other of street.portals) {
    assert.equal(other.lens.material, portal.lens.material, `${other.id} built its own lens texture`)
  }
  // ...and it is RELEASED with the rest, because §15's teardown is a definition of
  // done and a canvas left in `textures` is a 36 kB leak per run.
  assert.ok(street.textures.includes(portal.lens.material.map), `${portal.id}'s lens texture is not in the teardown list`)
})

// PASS12_REST

check('pass-12: the collapse does not change a single gameplay-visible second', () => {
  // THE BALANCE SIMULATION'S HALF OF THE ARGUMENT. `verify.mjs` proves the two
  // windows do not overlap arithmetically; this proves the OUTCOME is identical with
  // the collapse running and with it not, by driving the real three-portal sequence
  // twice and comparing every number the game publishes.
  //
  // THE OBVIOUS VERSION OF THIS CHECK IS VACUOUS, and it is worth saying why because
  // it is the version one writes first. "Shut three portals, wait 2 s, assert
  // nothing moved" would pass for a collapse that moved everything, because the
  // collapse by design moves NOTHING in `world.state` — it only writes to the scene
  // graph. So the claim being made is not "the state is unchanged" (true by
  // construction) but "the whole simulation is bit-identical with the collapse
  // running", and that is only answerable by running the same script twice.
  //
  // THE CONTROL RUNS THE SAME SCRIPT WITH NO COLLAPSE ANYWHERE, which means never
  // calling `setPortalShut` — §5.2's rule applied to the state directly, exactly as
  // the balance harness's own `placePortals` does. Two separate `BellLoopGame`
  // instances, because the shared one carries this file's accumulated state and two
  // runs of the same script through one instance is the thing pass 11's review
  // already recorded as "a measurement that read as its own opposite".
  const script = (world) => {
    world.start()
    for (const portal of world.streetView.portals) {
      const drawn = world.streetView.worldOf(portal.position)
      // stand off on the structure's own `facing`, which is what `capture.js` does
      world.player.teleport(drawn.x - portal.facing.x * 2.2, drawn.z - portal.facing.z * 2.2, 0)
      run(world, 0.4)
      if (!world.streetView.nearestPortal(world.player.pos)) continue
      // §5.2's own verb, driven through the same two paths a player drives it
      world.player.keys.add('KeyE')
      run(world, 1.4)
      world.player.keys.delete('KeyE')
      run(world, 0.1)
    }
    // ...and then past §10.1, so the finale, the dusk ramp and the creature's own
    // response to a quiet street are all inside the comparison
    run(world, 4.0)
    return {
      phase: world.phase,
      portals: { ...world.state.portals },
      progress: { ...world.state.progress },
      dusk: Number(world.state.dusk.toFixed(9)),
      finale: world.state.finale,
      creature: world.creature.state,
      awareness: Number(world.creatureAwareness.toFixed(9)),
      banishes: world.state.banishCount,
      portalsShut: rules.portalsShut(world.state.portals),
      held: world.state.hammerHeld,
      animTime: Number(world.animTime.toFixed(9)),
    }
  }
  const withCollapse = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  const without = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  try {
    const a = script(withCollapse)
    // ...and the same script with the view's collapse never armed. The verb is
    // applied to the state directly, which is what a portal does when §5.2 latches
    // and is the one thing this pass added no code path to.
    const b = script(without)
    for (const key of Object.keys(b)) {
      assert.deepEqual(
        a[key],
        b[key],
        `the 0.8 s collapse moved "${key}" — it is supposed to be pure aftermath with no gameplay consequence`,
      )
    }
    // AND THE SEQUENCE REALLY DID SHUT SOMETHING, or the comparison above is between
    // two runs that never reached the state the collapse is about. A balance check
    // that passes because nothing happened is the failure this line exists to stop.
    assert.ok(a.portalsShut > 0, 'the three-portal sequence shut no portals, so the collapse was never compared against anything')
    // ...and the collapse really did run, for the same reason: a comparison in which
    // the animation never armed is a comparison of two identical runs.
    assert.ok(
      withCollapse.streetView.portals.some((portal) => portal.collapseAt !== null || portal.shut),
      'no collapse was armed on the world the check is comparing, so the comparison proves nothing',
    )
  } finally {
    withCollapse.dispose()
    without.dispose()
  }
})

// PASS 12 IS PLACED HERE, IMMEDIATELY BEFORE THE PASS-11 FOOTFALL CHECK, and the
// placement is load-bearing rather than alphabetical. That check ends by calling
// `game.dispose()` and does not restore the world, and `dispose()` empties
// `streetView.textures` and releases every pool — so any check placed after it is
// running against a torn-down scene. The first version of this block sat after it
// and every assertion still passed, because the objects survive `dispose()` as
// objects; only the one assertion that reads the teardown list failed, and it
// failed for the right reason. Four checks that are green against a disposed world
// are four checks that are measuring a memory leak, which is not what they claim.
// ---------------------------------------------------------------------------

check('pass-11: a footfall puff is in the frame, and the cap holds in the built world', () => {
  // THE PASS-10 REVIEW'S FINDING, turned against this pass. Pass 10 shipped a trail
  // with nineteen mutations, four world checks and a whole section of prose, and not one
  // of them asked whether a mark was ever in front of a camera. "A puff exists" and "a
  // puff is in a picture" are different claims, and only the second is one a reviewer
  // ever sees — so this is a PROJECTION, against the real §16.5.8 staging, and it reports
  // pixel coordinates rather than asserting a threshold on alpha.
  const refreshCamera = () => {
    const camera = game.camera
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    return camera
  }
  // A puff is VISIBLE if it projects inside the frame and is still opaque enough to
  // read. The alpha floor is `PUFF_FADE`-aware for the trail's reason: a puff inside its
  // own ramp is still arriving and the harness's `wait` can catch one there.
  const VISIBLE_ALPHA = 0.2
  // READ OFF THE BUFFER AND NOTHING ELSE, and both halves of that are corrections. The
  // first version projected a centre built from `worldOf(puff.x)`, and `puff.x` is
  // ALREADY folded into the drawn copy by `_advancePuffs` — so the centre was folded
  // twice and sat a whole period away from the puff it was measuring, which inflated the
  // span from 52 px to 208 and put the "inside the frame" verdict on a point that is not
  // where the puff is. The second read slot 0 for every puff. So: the four corners come
  // out of the built geometry, the centre is their centroid, and the span is the widest
  // pair among them. Nothing here needs to know about §3.3's fold, which is the point —
  // a check that has to re-derive the fold to look at the buffer is a check with its own
  // copy of the bug.
  const inFrame = (puff, index, time) => {
    const camera = refreshCamera()
    const position = game.creatureView.puffGeometry.attributes.position
    const corners = []
    for (let i = 0; i < 4; i += 1) {
      const vertex = index * 4 + i
      corners.push(
        new THREE.Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).project(camera),
      )
    }
    const toPixels = (p) => ({ x: (p.x * 0.5 + 0.5) * 1280, y: (-p.y * 0.5 + 0.5) * 720 })
    const screen = corners.map(toPixels)
    const centre = {
      x: screen.reduce((sum, p) => sum + p.x, 0) / 4,
      y: screen.reduce((sum, p) => sum + p.y, 0) / 4,
    }
    // THE SPAN IS AN AXIS-ALIGNED BOUNDING BOX, because that is what `findEyes` measures:
    // `tools/png-luma.mjs` rejects a blob when `maxX - minX > EYE_MAX_SPAN` OR
    // `maxY - minY > EYE_MAX_SPAN`. The first version of this took the widest PAIR of
    // corners, which is the square's diagonal and is 1.41x the box — a gate that mirrors
    // another file's test has to measure what that file measures, or it is measuring its
    // own convenience.
    const spanX = Math.max(...screen.map((p) => p.x)) - Math.min(...screen.map((p) => p.x))
    const spanY = Math.max(...screen.map((p) => p.y)) - Math.min(...screen.map((p) => p.y))
    return {
      x: centre.x,
      y: centre.y,
      span: Math.max(spanX, spanY),
      spanX,
      spanY,
      depth: corners[0].z,
      alpha: beast.puffAlpha(time - puff.born),
      visible: centre.x >= 0 && centre.x < 1280 && centre.y >= 0 && centre.y < 720 && beast.puffAlpha(time - puff.born) > VISIBLE_ALPHA,
    }
  }
  // THE CHASE VIEW, staged exactly as `capture.js` stages it. `placeCreature` takes a
  // straight dx/dz in the CANONICAL frame, which is what `creaturePosition` is.
  const chase = cap.captureView('creature-chasing')
  {
    const seconds = chase.steps
      .slice(chase.steps.findIndex((step) => step.op === 'creature') + 1)
      .filter((step) => step.op === 'wait')
      .reduce((total, step) => total + step.seconds, 0)
    const spec = chase.steps.find((step) => step.op === 'creature')
    game.restart()
    // `start()` as well: `restart()` alone leaves the phase at RESET, and §9.3 says no
    // figure may be shown in that phase, so the world would correctly decline to draw
    // one and the dust would never be advanced. Every check that needs a live world says
    // both.
    game.start()
    run(game, 1.6)
    placeCreature(game, 0, -spec.metres)
    game.creature = beast.createCreature({ state: spec.state, awareness: 1 })
    game.dismissing = false
    game.dismissElapsed = 0
    game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
    run(game, seconds)
    const field = game.creaturePuffs
    assert.ok(field.laid > 0, `${chase.id} is staged for ${seconds}s and laid no puff at all`)
    assert.ok(field.puffs.length > 0, `${chase.id} laid ${field.laid} puffs and every one of them is already dead`)
    const projected = field.puffs.map((puff, index) => inFrame(puff, index, game.animTime))
    const seen = projected.filter((entry) => entry.visible)
    assert.ok(
      seen.length > 0,
      `${chase.id} laid ${field.puffs.length} puff(s) and NONE of them is inside the frame — they project to ` +
        `${projected.map((e) => `${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' ')} in a 1280x720 shot. The dust is in no ` +
        'picture, which is the pass-10 bug this check exists for. Give the chase longer, or stage it further out.',
    )
    // ...and they are in frame where the CAMERA can see them, which means the built
    // billboard is at a sane distance rather than projected from a stale matrix. The
    // harness's own control: a point at 3 m and one at 26 m must not land on the same
    // pixel, or nothing measured in screen space here means anything.
    assert.ok(
      seen.some((entry) => entry.span > 4),
      `every visible puff is ${Math.max(...seen.map((e) => e.span)).toFixed(1)} px across, which is a speck rather than a puff`,
    )
    // AND THE SPAN IS PAST `EYE_MAX_SPAN`, which is the other half of the dust's safety:
    // `tools/png-luma.mjs` flood-fills every compact blob at or above `EYE_MIN` 150 and
    // rejects anything spanning more than 14 px, so a puff the finder can see is a blob
    // the finder must reject. A puff INSIDE that span could be read as the creature's
    // eye and would cost `creatureContrast` its anchor.
    const widest = Math.max(...projected.map((entry) => entry.span))
    const widestOf = projected.reduce((a, b) => (b.span > a.span ? b : a))
    assert.ok(widest > 14, `a puff spans ${widestOf.spanX.toFixed(1)} x ${widestOf.spanY.toFixed(1)} px here, which is inside EYE_MAX_SPAN 14 and could be read as an eye`)
    // AND IT IS A REAL CHASE AT THE SHUTTER, not a stalk wearing a chase's filename.
    assert.equal(game.creature.state, 'chase', `${chase.id} waits ${seconds}s and the creature is no longer chasing`)
    console.log(
      `\n  pass-11 dust in frame: ${chase.id} laid ${field.laid} puff(s), ${field.puffs.length} alive, ` +
        `${seen.length} inside the frame at ${seen.map((e) => `${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' ')}; ` +
        `widest ${widestOf.spanX.toFixed(0)}x${widestOf.spanY.toFixed(0)} px at ${widestOf.depth.toFixed(2)} in NDC depth, against EYE_MAX_SPAN 14`,
    )
  }
  // THE CAP, in the BUILT world rather than in a reducer: walk the creature far enough to
  // want more puffs than `PUFF_MAX` and require the buffer to hold exactly `PUFF_MAX`
  // quads with alpha on every one of them. This is the claim that distinguishes a cap
  // from a comment, and only the scene can see it — the reducer's own list is the same
  // length either way.
  {
    game.restart()
    game.start()
    run(game, 1.6)
    placeCreature(game, 0, -9)
    game.creature = beast.createCreature({ state: 'chase', awareness: 1 })
    game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
    // `PUFF_MAX` is set against 5.2 / 0.45 x 0.95 = 11 puffs ALIVE, and 0.95 s of
    // walking at 5.2 m/s is 4.94 m, which is 5.5 seconds and 330 frames. The first
    // version of this loop asked for `ceil(11) + 4` FRAMES, which is 1.4 m of road and
    // three puffs — and it failed with "the cap walk laid 2, which is not more than the
    // cap", which is the right failure for the right reason: a cap you cannot reach is a
    // comment. The walk is sized in METRES and the frame count follows from it.
    const metres = (beast.SPEED_CEILING / beast.FOOTFALL_STRIDE_METRES) * beast.PUFF_LIFE + 3
    const want = Math.ceil(metres / (beast.SPEED_CEILING * DT))
    let creatureX = 0
    for (let i = 0; i < want; i += 1) {
      creatureX += beast.SPEED_CEILING * DT
      game.creaturePosition = { x: hood.canonicalCoord(game.player.pos.x) + creatureX, z: hood.canonicalCoord(game.player.pos.z) - 9 }
      game.update(DT)
    }
    assert.ok(game.creaturePuffs.laid > beast.PUFF_MAX, `the cap walk laid ${game.creaturePuffs.laid}, which is not more than the cap`)
    const colour = game.creatureView.puffGeometry.attributes.color
    let lit = 0
    for (let puff = 0; puff < beast.PUFF_MAX; puff += 1) {
      if (colour.getW(puff * 4) > 0) lit += 1
    }
    assert.equal(game.creaturePuffs.puffs.length, beast.PUFF_MAX, `the field holds ${game.creaturePuffs.puffs.length}, not PUFF_MAX`)
    assert.equal(lit, beast.PUFF_MAX, `only ${lit} of the buffer's ${beast.PUFF_MAX} quads carry a puff, so the rest are stale`)
    assert.equal(game.creatureView.puffs.visible, true)
    assert.equal(
      game.creatureView.puffGeometry.attributes.position.count,
      beast.PUFF_MAX * 4,
      'the puff buffer is not sized to the cap, so a version that grew the field would write past it',
    )
  }
  // AND IT IS RELEASED WITH THE WORLD, which §15's teardown is the only place to see.
  {
    const view = game.creatureView
    game.dispose()
    assert.equal(view.puffs.parent, null, 'the puff field was left on the scene after dispose')
    assert.equal(view.haze.parent, null, 'the shimmer was left on the scene after dispose')
    assert.equal(view._geometries.includes(view.puffGeometry), false, 'and its geometry was not released')
    assert.equal(view._geometries.includes(view.hazeGeometry), false, 'and the shimmer geometry was not')
    assert.equal(view._materials.includes(view.puffMaterial), false, 'and the puff material was not')
    assert.equal(view._materials.includes(view.hazeMaterial), false, 'and the shimmer material was not')
  }
})

// ---------------------------------------------------------------------------
// iteration 2, pass 17 — the budget, counted off the built world
//
// WHY THIS IS HERE AND NOT ONLY IN `tools/capture.mjs --budget`
// -----------------------------------------------------------
// Because the live mode needs a browser and a GPU, and this runs on every commit.
// The two halves measure different things and only one of them is a draw call:
//
//  - `tools/capture.mjs --budget` reads `renderer.info.render.calls` off a frame a
//    driver actually drew. That is the budgeted number and nothing here can
//    replace it.
//  - THIS measures the scene GRAPH: objects, instanced pools, instance counts,
//    resident triangles, distinct geometries, materials and culling exemptions.
//
// The graph census OVERSTATES draw calls (an `InstancedMesh` is one object for any
// number of instances) and it is still the right thing to hold statically, for two
// reasons. It is the number a change moves first — nobody converts forty-two
// meshes into one instanced mesh by accident — and it is the only half that can
// catch the regression in the ten seconds between commits, on a machine with no
// GPU at all.
//
// The ceilings are read from `src/game/capture.js` rather than restated, so a
// retune is one edit and the two instruments cannot end up judging the same budget
// by different numbers.
// ---------------------------------------------------------------------------

check('pass-17: the built scene is inside the triangle and geometry budget, and its cost is instanced', () => {
  // ITS OWN WORLD, and the reason is positional rather than defensive: this check
  // sits after the puff field's teardown, and that check ends with `game.dispose()`
  // on the SHARED instance — which is correct for it and leaves this one looking at
  // a scene whose three views have been removed from it. `game.restart()` resets
  // simulation state and does not rebuild the graph, so a census taken here without
  // a fresh world would count an empty scene. The pass-11 collapse check records the
  // same lesson from the other direction: "a measurement that read as its own
  // opposite" was a reused instance carrying a previous run's state.
  const scratch = new BellLoopGame(container, { store: createStartStore(), audio: makeFakeAudio(), createRenderer: makeFakeRenderer })
  run(scratch, 0.5)
  const view = scratch.streetView
  const scene = scratch.scene

  // THE CENSUS, and it is the same traversal `tools/perf-census.mjs` and the capture
  // page's `census` both run, written out a third time because each of the three is a
  // different process: node without a renderer, chrome with one, and this harness.
  // The numbers are cross-checked against the other two below, which is what makes
  // the duplication safe — three copies that have to agree.
  const census = (root) => {
    const kinds = { instanced: 0, mesh: 0, points: 0, line: 0, sprite: 0, light: 0 }
    let unculled = 0
    let instances = 0
    let triangles = 0
    const geometries = new Set()
    const materials = new Set()
    root.updateMatrixWorld(true)
    root.traverse((object) => {
      if (object.isInstancedMesh) kinds.instanced += 1
      else if (object.isMesh) kinds.mesh += 1
      else if (object.isPoints) kinds.points += 1
      else if (object.isLine) kinds.line += 1
      else if (object.isSprite) kinds.sprite += 1
      else if (object.isLight) kinds.light += 1
      else return
      if (object.frustumCulled === false) unculled += 1
      if (!object.geometry) return
      const geometry = object.geometry
      geometries.add(geometry.uuid)
      const material = object.material
      if (Array.isArray(material)) material.forEach((entry) => materials.add(entry.uuid))
      else if (material) materials.add(material.uuid)
      const per = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
      const count = object.isInstancedMesh ? object.count : 1
      instances += count
      triangles += per * count
    })
    return { kinds, unculled, instances, triangles: Math.round(triangles), geometries: geometries.size, materials: materials.size }
  }
  const whole = census(scene)
  const street = census(view.group)
  const sky = census(scratch.skyView.root)
  const drawable = whole.kinds.instanced + whole.kinds.mesh + whole.kinds.points

  // 1. THE TWO CEILINGS, on the whole scene. Both are read from `capture.js`, and
  //    the message names the measured number because a ceiling nobody quotes is a
  //    ceiling nobody can act on.
  assert.ok(
    whole.triangles <= cap.BUDGET.triangles,
    `the world submits ${whole.triangles} triangles, over the ${cap.BUDGET.triangles} ceiling`,
  )
  assert.ok(
    whole.geometries <= cap.BUDGET.geometries,
    `the world holds ${whole.geometries} geometries, over the ${cap.BUDGET.geometries} ceiling`,
  )
  // 2. AND THE INSTANCING IS DOING THE WORK, which is the claim the numbers exist to
  //    support. The city is 16 000-odd instances across a few dozen pools; if that
  //    ratio collapsed, the draw-call count would be the scene graph and the budget
  //    would be a different argument entirely. A hundred instances per pool is a
  //    floor and not a target: the cheapest kind in the set (a 12-triangle yard) is
  //    over four hundred, and the most expensive (the wire ribbon) is one object.
  const pools = whole.kinds.instanced
  assert.ok(pools >= 30, `only ${pools} instanced meshes, so the world has lost the instancing that holds its draw calls down`)
  assert.ok(
    whole.instances / pools > 100,
    `the ${pools} instanced meshes carry ${whole.instances} instances, so they are not earning their draw calls`,
  )
  // 3. AND THE ROAD IS THE INSTANCED HALF, which is the specific claim the fidelity
  //    passes have to be held to: passes 5-12 added houses, poles, wires, furniture,
  //    ground detail and cars, and every one of them went into a pool rather than
  //    onto the graph. At the slice-16 baseline `streetView` held 19 pools; it holds
  //    62, and `tools/perf-census.mjs --tree <bede4ed>` measured the baseline to be
  //    the same 19.
  // ...and every instanced mesh in the street is accounted for BY NAME, which is
  // stronger than a count. `view.pools` is the `InstancePool` registry (every
  // fixture and every lot part); the three portal debris rings are built directly
  // in `_buildPortals` as `InstancedMesh`es and deliberately are not pools, because
  // a pool is a reused geometry with a fixed capacity and a ring is rewritten every
  // frame. Both halves are named so a fourth unaccounted ring would fail here.
  assert.equal(
    street.kinds.instanced,
    view.pools.length + view.portals.length,
    'the census found instanced meshes in the street that neither view.pools nor the portal rings account for',
  )
  assert.ok(
    street.kinds.instanced >= 60,
    `streetView holds ${street.kinds.instanced} instanced meshes, down from the 62 passes 5-12 built`,
  )
  // 4. THE SKY IS SIX OBJECTS, and this is the one number this pass moved. It was 47
  //    (forty-two horizon boxes, a moon, three bands and a point cloud) and it is now
  //    6, because the ring is one `InstancedMesh`. The TRIANGLES ARE UNCHANGED at 542
  //    — twelve per instance, forty-two instances — and that is the whole proof that
  //    the merge cost the picture nothing. Both halves are asserted because either
  //    alone would pass on a regression that broke the other.
  assert.equal(sky.kinds.instanced, 1, `the sky holds ${sky.kinds.instanced} instanced meshes, so the ring is not one`)
  assert.equal(sky.kinds.mesh, 4, `the sky holds ${sky.kinds.mesh} plain meshes — a moon and three bands — and nothing else should be a mesh`)
  assert.equal(sky.triangles, 542, `the sky costs ${sky.triangles} triangles, not the 542 the instanced ring was measured at before the merge`)
  // 5. AND NOTHING IN THE SKY IS CULLING-EXEMPT BY ACCIDENT. Every sky object is
  //    camera-relative, so all six are exempt by design — and the count is six, so a
  //    seventh object appearing exempt is a change somebody made and did not mean.
  assert.equal(sky.unculled, 6, `${sky.unculled} of the sky's six objects are culling-exempt`)
  // 6. THE GRAPH OVERSTATES CALLS AND THIS CHECK SAYS SO. `drawable` is objects, not
  //    calls: 143 objects is fewer calls than it looks like only because 62 of them
  //    are pools. The published `renderer.info.render.calls` for this same world is
  //    111 at the avenue pose and 140 at the portal, and the two numbers are RELATED
  //    rather than equal. Asserting the live figure here would be asserting a number
  //    this harness cannot measure, so what is asserted is the bound it must not
  //    exceed: the graph is already inside the draw-call ceiling before culling has
  //    removed anything at all, which is the only direction that can be checked
  //    without a driver.
  assert.ok(
    drawable <= cap.BUDGET.drawCalls,
    `the scene graph holds ${drawable} drawable objects, over the ${cap.BUDGET.drawCalls} ceiling even before culling`,
  )
  console.log(
    `\n  pass-17 budget: ${drawable} drawable objects (${whole.kinds.instanced} instanced + ${whole.kinds.mesh} mesh + ` +
      `${whole.kinds.points} points), ${whole.instances} instances over them, ${whole.triangles} triangles ` +
      `(ceiling ${cap.BUDGET.triangles}), ${whole.geometries} geometries (ceiling ${cap.BUDGET.geometries}), ` +
      `${whole.materials} materials, ${whole.unculled} culling-exempt; sky ${sky.triangles} triangles in ` +
      `${sky.kinds.instanced + sky.kinds.mesh + sky.kinds.points} objects`,
  )
  // ...and the world it measured is released like any other, because §15's teardown
  // claim is "every mount releases everything" and a check that leaked a world would
  // be the one place in the file that did not.
  scratch.dispose()
  assert.equal(scratch.disposed, true, 'the budget world did not dispose, so this check leaked a scene')
})

check('dispose() tears the whole world down without throwing', () => {
  // §15's definition of done. A `dispose` that throws takes React's unmount down
  // with it and leaves a WebGL context alive behind the next mount, so the frame
  // *after* the teardown is part of the assertion: it is the one that proves the
  // RAF was cancelled and nothing is still holding the scene.
  game.restart()
  run(game, 1.6)
  const view = game.creatureView
  game.dispose()
  assert.equal(game.disposed, true)
  assert.equal(view.disposed, true, 'the creature view disposed')
  assert.equal(view.root.parent, null, 'and removed itself from the scene')
  assert.equal(game.streetView.pools.length, 0, 'the instanced pools are released')
  assert.equal(game.streetView.textures.length, 0, 'and so are the procedural textures')
  // PASS 10: the trail is a SIBLING of the figure, so removing the figure does not
  // remove it, and §15's teardown is the only thing in the repository that would notice.
  assert.equal(game.creatureView.trail.parent, null, 'the trail was left on the scene after dispose')
  assert.equal(game.creatureView._geometries.includes(game.creatureView.trailGeometry), false, 'and its geometry was not released')
  assert.equal(game.creatureView._materials.includes(game.creatureView.trailMaterial), false, 'and its material was not')
  // and it is idempotent, because `dispose` may legitimately be called twice on
  // the way out of a hot reload
  game.dispose()
  game.update(0.1)
})

// ---------------------------------------------------------------------------
// iteration 2, pass 13 — the world bed, on the real world
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK OWNS, AND WHY IT CANNOT BE A COPY OF verify.mjs
// --------------------------------------------------------------
// `verify.mjs` proves the bed's NUMBERS: the gaps, the placement, the distance
// model, the wind's monotonicity, the absence of `Math.random`. Every one of
// those is a pure function, and every one of them could be true while the game
// handed the audio a frame that says nothing.
//
// This block proves the four things a pure function cannot:
//
//   1. THE LISTENER IS THE PLAYER. The frame's `position` and `yaw` are read back
//      out of a world the player has been moved around in, so a world that passed
//      the camera instead of the body — or a stale copy from spawn — fails here
//      and not in the pure file.
//   2. THE HAZE IS THE SKY'S OWN READING, AND IT MOVES. The world's `haze` is
//      compared against `hazeIntensityAt(animTime, seed)` read from the same
//      function the renderer uses, and it is required to CHANGE over a run: a
//      coupling to a constant is not a coupling, and a gate that only checked
//      "haze is a number" would pass a world that passed a literal.
//   3. THE NOISE RESPONDS TO WHERE THE PLAYER STANDS. A facility event is placed
//      by the seed, the player is teleported to two real positions inside this
//      world, and `facilityVoice` is asked about both.
//   4. THE PAUSE REACHES THE BED. The world's own frame sequence — including a
//      pause — is replayed through the audio's real cursor machine, and the
//      clock it advanced by must be the sum of the PLAYED frames only. This is
//      the check the old `setTimeout` chain could not have passed, and the whole
//      reason it is gone.

check('the world hands the bed the player\'s own position and facing', () => {
  game.restart()
  run(game, 1.6)
  const before = audio.lastFrame
  assert.ok(before, 'the world never handed the audio a frame')
  assert.deepEqual(
    before.position,
    { x: game.player.pos.x, z: game.player.pos.z },
    'the frame is not the player\'s own position',
  )
  assert.equal(before.yaw, game.player.yaw, 'the frame is not the player\'s own facing')
  assert.equal(typeof before.haze, 'number', 'the frame carries no haze')
  assert.ok(before.haze >= 0 && before.haze <= 1, `the haze is ${before.haze}, outside [0, 1]`)

  // walking moves it, and the value follows the body rather than a copy of spawn
  const spawn = { x: before.position.x, z: before.position.z }
  game.player.teleport(spawn.x + 12, spawn.z - 7, 0.9)
  game.update(DT)
  assert.deepEqual(audio.lastFrame.position, { x: game.player.pos.x, z: game.player.pos.z })
  assert.ok(
    Math.hypot(audio.lastFrame.position.x - spawn.x, audio.lastFrame.position.z - spawn.z) > 10,
    'the frame did not follow the body',
  )
  assert.equal(audio.lastFrame.yaw, game.player.yaw)
  assert.notEqual(audio.lastFrame.yaw, before.yaw, 'the facing in the frame never changes')
  // and it is the BODY, not the camera. The eye is 1.6 m above the body and
  // carries the bob, so a frame built from `camera.position` would be a
  // THREE-key object where this is a two-key one — which is the only difference
  // there is to see, because the camera's X and Z ARE the body's.
  assert.deepEqual(Object.keys(before.position).sort(), ['x', 'z'], 'the frame position is not a two-axis body position')
  assert.ok(
    game.camera.position.y > game.player.pos.y,
    'the eye is not above the body, so the two could not be told apart',
  )
})

check('the wind follows a haze that moves, and it is the sky\'s own number', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  // the world's haze IS the sky's own reading. Note the two clocks: the sky keeps
  // its OWN (`skyView._time`, which a loop does not reset) and the world keeps
  // `animTime` (which one is), so the check is written against the sky's clock
  // rather than the world's — a coupling to a *different* module's clock is
  // exactly the bug this guards, and it would pass if the two happened to be
  // equal in a fresh world.
  let clock = 0
  for (const seconds of [0, 12, 40, 90]) {
    run(game, seconds - clock)
    clock = seconds
    assert.equal(
      game.skyView.hazeIntensity(),
      hazeIntensityAt(game.skyView._time, game.seed),
      'the sky is not reading its own function',
    )
    assert.equal(audio.lastFrame.haze, game.skyView.hazeIntensity(), 'the world is not handing over the sky\'s reading')
  }
  // and it MOVES. A coupling to a constant is not a coupling: 96 s is more than a
  // whole cycle at `HAZE_AUDIO_CYCLE` 24 on the first band, and the readings must
  // differ
  const readings = []
  for (let i = 0; i < 24; i += 1) {
    run(game, 4)
    readings.push(audio.lastFrame.haze)
  }
  const distinct = new Set(readings.map((value) => value.toFixed(6))).size
  assert.ok(distinct > 12, `the haze took ${distinct} values in 96 s, so it is barely moving`)
  for (const value of readings) assert.ok(value >= 0 && value <= 1, `${value} is outside [0, 1]`)
  // it is not a sawtooth either: the wind's own filter is written with a 0.8 s
  // constant, so a number that jumped 0.6 between two frames 4 s apart would be a
  // zipper waiting to happen
  let biggest = 0
  for (let i = 1; i < readings.length; i += 1) biggest = Math.max(biggest, Math.abs(readings[i] - readings[i - 1]))
  assert.ok(biggest < 0.35, `the haze jumped by ${biggest.toFixed(3)} in 4 s`)
  // THE COUPLING, measured on the audio's own answer rather than on the sky's:
  // over this window the wind level must have moved with the haze, and in the same
  // direction every time it moved
  const winds = readings.map((haze) => audioModule.hazeWindVoice({ started: true, playing: true, haze }).level)
  let moved = 0
  for (let i = 1; i < readings.length; i += 1) {
    const dh = readings[i] - readings[i - 1]
    if (Math.abs(dh) < 1e-9) continue
    moved += 1
    assert.ok(Math.sign(winds[i] - winds[i - 1]) === Math.sign(dh), `the wind moved against the haze at step ${i}`)
  }
  assert.ok(moved > 8, `the haze only moved ${moved} times in 96 s, so the coupling is untested`)
  assert.ok(new Set(winds.map((value) => value.toFixed(8))).size > 12, 'the wind did not move with the haze')
  // the seed is part of the coupling: the same clock on a different run is a
  // different reading, so two runs of the same street are not one run's weather
  assert.notEqual(hazeIntensityAt(60, 1337), hazeIntensityAt(60, 4242), 'the haze ignores the seed')
  assert.equal(hazeIntensityAt(60, 1337), hazeIntensityAt(60, 1337), 'the haze is not a function of its inputs')
  assert.ok(HAZE_AUDIO_CYCLE > 1, 'the audio cycle was retuned to 1, which is the band rate itself')
})

check('a facility noise is louder and brighter where the player is standing', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  // the event is a fixed point in the city, placed by the seed alone
  const [event] = audioModule.ambienceStream('facility', game.seed, 1)
  const kind = audioModule.FACILITY_KINDS[event.kind]
  // the player is really teleported into the world and the frame is really
  // rebuilt: the point is that the two positions below are positions the WORLD
  // reported, not numbers this check chose
  const stand = (x, z) => {
    game.player.teleport(x, z, 0)
    game.update(DT)
    return audio.lastFrame.position
  }
  const near = stand(event.x + 15, event.z)
  const far = stand(event.x + 170, event.z)
  const here = audioModule.facilityVoice(event, { position: near, yaw: 0 })
  const there = audioModule.facilityVoice(event, { position: far, yaw: 0 })
  assert.ok(Math.abs(here.distance - 15) < 0.2, `the near listener is ${here.distance.toFixed(1)} m from the noise`)
  assert.ok(Math.abs(there.distance - 170) < 0.2, `the far listener is ${there.distance.toFixed(1)} m from the noise`)
  assert.ok(here.level > there.level * 5, 'the near listener is not much closer to hearing it')
  assert.ok(here.damp > there.damp, 'the near listener does not hear it more clearly')
  assert.equal(here.level, kind.level * beast.soundStrength(here.distance, audioModule.FACILITY_RANGE))
  // and the whole way in, from a standing start: five real positions inside this
  // world, one level and one pan each, falling as the player walks away
  let previous = Infinity
  let previousDamp = Infinity
  for (const offset of [0, 30, 60, 120, 190]) {
    const at = audioModule.facilityVoice(event, { position: stand(event.x + offset, event.z), yaw: 0 })
    assert.ok(at.level < previous, `the noise got louder at ${offset} m from the player`)
    assert.ok(at.damp <= previousDamp, `the noise got brighter at ${offset} m from the player`)
    previous = at.level
    previousDamp = at.damp
  }
  // the pan follows the body's facing, and the body's facing is in the frame
  game.player.teleport(event.x + 15, event.z, Math.PI)
  game.update(DT)
  const turned = audioModule.facilityVoice(event, { position: audio.lastFrame.position, yaw: audio.lastFrame.yaw })
  assert.ok(turned.pan * here.pan < 0, 'turning on the spot did not move the facility noise')
  assert.equal(turned.level, here.level, 'turning changed the level')
  // and the two placements really are different answers from one event, which is
  // the claim the whole placement buys: the noise is in the world, not at the
  // speaker
  assert.equal(there.kind, here.kind, 'the same noise changed its mind about what it is')
  assert.notEqual(there.level, here.level, 'standing 155 m away changed nothing')
})

check('a pause freezes the bed, and a hidden tab does not fire a backlog', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  // The world's own frame sequence, recorded as (dt, did the router say the run
  // was started), with a real pause in the middle. This is the composition the
  // pass claims: the world freezes, the router says nothing, and the audio's
  // cursor therefore does not move.
  const sequence = []
  for (let i = 0; i < 180; i += 1) {
    game.update(DT)
    sequence.push({ dt: DT, routed: routeAudio(audio.lastFrame).length > 0 })
  }
  game.setPaused(true)
  const frozenTime = game.animTime
  for (let i = 0; i < 120; i += 1) {
    game.update(DT)
    sequence.push({ dt: DT, routed: routeAudio(audio.lastFrame).length > 0 })
  }
  game.setPaused(false)
  assert.equal(game.animTime, frozenTime, 'the pause did not freeze the world clock')

  // replay the same sequence through the audio's REAL cursor machine — a real
  // AudioManager with no context, which is the honest way to drive the clock with
  // none of the audio around it
  const manager = new audioModule.AudioManager()
  manager.setSeed(game.seed)
  const fired = []
  let routedFrames = 0
  for (const frame of sequence) {
    // the composition the pass claims: the router sends no row on a paused frame,
    // so no voice runs, so the cursor does not move. Skipping here is not a
    // convenience — it is the thing being tested.
    if (!frame.routed) continue
    routedFrames += 1
    manager._advanceAmbience('drip', frame.dt, (event) => fired.push(event))
  }
  assert.ok(sequence.some((frame) => !frame.routed), 'the pause routed audio, so this check proved nothing')
  // the tolerance is a second's worth of float on 180 additions of 1/60, which is
  // the whole of the error: a 1e-9 slack is not slack, it is the representation
  assert.ok(
    Math.abs(manager.ambience.get('drip').clock - routedFrames * DT) < 1e-9,
    `the bed advanced by ${manager.ambience.get('drip').clock} s over ${routedFrames} routed frames`,
  )
  // ...which is exactly the 180 played frames, and the 120 paused ones contributed
  // nothing. The old `setTimeout` chain advanced through all of them.
  assert.ok(Math.abs(manager.ambience.get('drip').clock - 180 * DT) < 1e-9, 'the bed moved during the pause')
  // and the manager's cursor agrees with the pure schedule for the frames it played
  const played = sequence.filter((frame) => frame.routed).reduce((sum, frame) => sum + frame.dt, 0)
  const expected = audioModule.ambienceStream('drip', game.seed, fired.length + 1).filter((event) => event.at <= played)
  assert.deepEqual(fired, expected, 'the bed did not play the schedule the pause shortened')

  // THE HIDDEN TAB, on the same machine: a single enormous frame must not stack a
  // backlog, and the cursor must come out the far side of it
  const tabbed = new audioModule.AudioManager()
  tabbed.setSeed(game.seed)
  const burst = []
  const oneFrame = tabbed._advanceAmbience('drip', 900, (event) => burst.push(event))
  assert.equal(oneFrame, audioModule.AMBIENCE_MAX_PER_FRAME, 'a fifteen-minute frame played its whole backlog')
  assert.equal(burst.length, audioModule.AMBIENCE_MAX_PER_FRAME)
  assert.ok(tabbed.ambience.get('drip').at >= 900, 'the cursor is still behind the clock after a hidden tab')
})

// iteration 2, pass 14 — the music, on the real world
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK OWNS, AND WHY A PURE FUNCTION CANNOT ANSWER IT
// -------------------------------------------------------------
// `verify.mjs` proves the music's numbers: the scale, the ladder, the cut, the
// schedule. Every one of those is a pure function of a frame, and every one of them
// could be true while the world handed the audio a frame that says nothing — which is
// exactly the shape of the bug this repository already has a scar for. What has to be
// shown HERE is four things a pure function cannot reach:
//
//   1. **THE CLOCK IS THE WORLD'S.** `lastFrame.time` is `game.animTime` on a world
//      that has been played, paused and resumed, and the pad's chord has to follow it
//      exactly. A world that passed a literal 0 would play a perfect, silent,
//      four-second chord for a whole run, and every pure check would still pass.
//   2. **THE PAUSE FREEZES THE PROGRESSION.** Not the cursor — the CHORD. `animTime`
//      is the number the pad is a function of, so a pause that failed to freeze it
//      would be a pad changing chord under the pause card, and the only way to see
//      that is to read the chord on the frame before and the frame after.
//   3. **THE FINALE IS THE SAME FLAG THE HEADLIGHTS READ.** `state.finale` drives the
//      music's silence, the car's lights, the dusk ramp and the fog. A music that
//      watched a different flag would cut on the wrong frame, and one that cut the
//      world bed as well would be §13's two halves confused.
//   4. **THE LADDER ANSWERS A REAL CREATURE.** The threat is `max(proximity,
//      awareness)`; the pure gate walks both numbers, and this puts an actual creature
//      at an actual distance in an actual world and reads what the world would route.

check('the music plays on the world\'s own clock, and a pause freezes the progression', () => {
  game.restart()
  game.start()
  run(game, 1.6)
  assert.ok(audio.lastFrame, 'the world never handed the audio a frame')
  assert.equal(audio.lastFrame.time, game.animTime, 'the music is not on the world\'s clock')
  // ...and the pad is a pure function of that number, so the chord follows the world
  const read = () => audioModule.musicChordAt(audio.lastFrame.time, game.seed)
  const before = read()
  const playedFrom = before.at
  assert.ok(before.step >= 0, 'the world clock is behind the first chord')
  // a minute of play moves the progression through real chords, and the number of
  // chord changes is the one the world's own clock says it should be
  run(game, 60)
  const after = read()
  assert.ok(after.step - before.step >= 12, `a minute of play moved the pad by ${after.step - before.step} chords`)
  assert.equal(
    after.step - before.step,
    Math.floor((game.animTime - playedFrom) / audioModule.MUSIC_CHORD_SECONDS),
    'the pad and the world disagree about how many chords have passed',
  )
  // THE PAUSE. §14.3 freezes `animTime` before the audio is updated, and the frame a
  // paused world builds is the SILENCE frame — `{ started: false }`, with no facts in
  // it at all. So the claim is not "the music's time is unchanged"; it is "the world
  // stopped advancing the number the music is a function of, and told the audio
  // nothing". A world that kept its clock running under the pause card would change
  // the pad's chord while insisting the game was stopped, and the only place that is
  // visible is here.
  const frozen = { time: game.animTime, chord: read() }
  game.setPaused(true)
  for (let i = 0; i < 180; i += 1) game.update(DT)
  assert.equal(audio.lastFrame.started, false, 'a paused world still handed the audio a frame of facts')
  assert.equal(game.animTime, frozen.time, 'the world clock moved while paused')
  // ...so the chord the pad would be on is the chord it was on, which is the whole
  // reason the progression is a pure function of `frame.time` and not a cursor
  assert.deepEqual(audioModule.musicChordAt(game.animTime, game.seed), frozen.chord, 'the pad changed chord while the game was paused')
  game.setPaused(false)
  run(game, audioModule.MUSIC_CHORD_SECONDS * 2)
  assert.notEqual(read().index, frozen.chord.index, 'the pad never came back')
  assert.ok(audio.lastFrame.time > frozen.time, 'the clock did not restart after the pause')
})

check('the finale is the music\'s silence, and it is the creature\'s flag too', () => {
  game.restart()
  game.start()
  run(game, 1.2)
  // before: music on, finale off
  assert.equal(audio.lastFrame.finaleEnraged, false, 'a fresh run is in a finale')
  const playing = audioModule.musicVoice(audio.lastFrame)
  assert.ok(playing.level > 0 && playing.tone === 0, 'the music is not playing before the finale')
  // the finale is the LATCHED flag, reported as a fact, and the creature is on the
  // field so the cut is not "the creature is asleep" wearing a finale's clothes
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  game.state = { ...game.state, finale: true }
  game.update(DT)
  assert.equal(audio.lastFrame.finaleEnraged, true, 'the world did not report the finale')
  const finale = audioModule.musicVoice(audio.lastFrame)
  assert.equal(finale.level, 0, 'the music is still playing in the finale')
  assert.equal(finale.hiss, 0, 'the hiss survived the cut')
  assert.equal(finale.silent, true)
  assert.ok(finale.tone > 0, 'the finale left nothing at all')
  // THE OTHER READER OF THE SAME FLAG, on the same frame. §10.2's enrage hangs off
  // `state.finale` inside `creatureStep`, and the music's silence hangs off it in
  // `_audioFrame`; a music that watched a flag of its own, or a flag read on a
  // different frame, would cut on a frame where nothing else in the game had changed.
  // The headlights are the third reader and they are NOT tested here, on purpose:
  // §10.3 lights them from `_onPortalShut`, so reaching them means shutting three
  // portals for real, and the third-portal block above already does that.
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  game.state = { ...game.state, finale: true }
  game.update(DT)
  assert.equal(audio.lastFrame.finaleEnraged, true, 'the world did not report the finale')
  assert.equal(game.creature.state, 'enraged', 'the creature did not take the same flag the music did')
  // THE WORLD BED IS NOT SILENCED WITH IT. That is §13's split, measured: the bed
  // rides the drone's ladder and the music has its own, so a cut music is the one
  // moment the world is louder than the score.
  const routed = audioModule.routeAudio(audio.lastFrame)
  const room = routed.find((cue) => cue.id === 'roomTone')
  assert.ok(room.params.level > 0, 'the finale silenced the room tone as well')
  const drone = routed.find((cue) => cue.id === 'drone')
  assert.equal(drone.params.level, audioModule.DRONE_LEVEL, 'the finale ducked the drone as well')
  // ...and the note stream stops too, which is a different claim from the pad's and is
  // the difference between a silence and a soundtrack with a gap in it
  const motif = routed.find((cue) => cue.id === 'musicMotif')
  assert.equal(motif.params.motif, 0, 'a note is still scheduled in the finale')
  assert.equal(audioModule.musicMotifVoice({ a: 0.5, b: 0.5, c: 0.5 }, motif.params).level, 0)
  // The world's own cursors keep running through the finale, and the music's does
  // not, in the same loop and on the same frames — which is what makes the cut
  // legible: a city that went quiet with its music would not be frightening. The
  // motif is advanced exactly as `updateMusicMotif` does it, from the frame the world
  // actually handed over, rather than by hand, so this is the voice's gate measured
  // on real frames.
  const manager = new audioModule.AudioManager()
  manager.setSeed(game.seed)
  const heard = []
  const breathed = []
  for (let i = 0; i < 60 * 20; i += 1) {
    const cue = audioModule.routeAudio(audio.lastFrame).find((entry) => entry.id === 'musicMotif')
    if (cue.params.playing === true && cue.params.silent !== true && cue.params.motif > 0) {
      manager._advanceAmbience('motif', DT, (event) => heard.push(event))
    }
    manager._advanceAmbience('gust', DT, (event) => breathed.push(event))
    game.update(DT)
  }
  assert.ok(breathed.length > 0, 'the world stopped breathing in the finale')
  assert.equal(heard.length, 0, 'a note was played in the finale')
})

check('the ladder answers a real creature, at a real distance', () => {
  game.restart()
  game.start()
  run(game, 1.2)
  // The creature is AWAKE for this one, and that is load-bearing rather than tidiness:
  // `creaturePresent` is false for a dormant or staggered creature, and §7.4's
  // banish is a removal, so a ladder measured against a sleeping creature is a
  // ladder that never moves. The music is only supposed to duck for something that
  // is actually out there.
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  // The PLAYER is moved rather than the creature, and the reason is the harness's
  // own seam rather than a preference: `update()` runs the creature's AI before it
  // builds the audio frame, so anything written into `creaturePosition` is overwritten
  // a few lines before the audio reads it — the same class of mistake the harness's
  // own notes record about the swing reach and the capture radius. Teleporting the
  // player to a real offset from the creature's CANONICAL position is the move that
  // survives a frame, and it is what the facility check above already does.
  const stand = (offset) => {
    const at = game.creaturePosition
    game.player.teleport(at.x + offset, at.z, 0)
    game.update(DT)
    return audio.lastFrame
  }
  const far = stand(180)
  const middle = stand(15)
  const near = stand(3)
  // and the distances below are the WORLD's, not numbers this check chose
  assert.ok(far.creatureDistance > 100, `the far listener is ${far.creatureDistance.toFixed(1)} m away`)
  assert.ok(near.creatureDistance < 8, `the near listener is ${near.creatureDistance.toFixed(1)} m away`)
  const voiceOf = (frame) => audioModule.musicVoice(frame)
  const levels = [voiceOf(far).level, voiceOf(middle).level, voiceOf(near).level]
  assert.ok(levels[0] > levels[1] && levels[1] > levels[2], `the music did not duck as the creature approached: ${levels.join(' > ')}`)
  assert.ok(levels[2] > 0, 'the music stops when the creature arrives, which is a cue and not a duck')
  // and the frame's own two readouts are what drove it, over the same 30 m the breath
  // panics on: three metres is inside it and 180 is well outside
  assert.equal(voiceOf(far).safe, true, '180 m is not a safe zone')
  assert.equal(voiceOf(near).safe, false, '3 m is a safe zone')
  assert.ok(
    Math.abs(audioModule.proximityAt(near.creatureDistance, 30) - voiceOf(near).threat) < 1e-9,
    'the threat is not the proximity the frame reported',
  )
  // the two ends of the walk are the ladder's own two rungs rather than two extra
  // rules: the far end is the safe rung exactly, and the near end is whatever the
  // threat the world reported says it is — 3 m is 0.9 of a 30 m range, not 1, and a
  // check that assumed 1 would be asserting a distance the harness chose instead
  assert.equal(voiceOf(far).ladder, audioModule.musicLadderAt(0), 'the far end is not the safe rung')
  assert.equal(voiceOf(near).ladder, audioModule.musicLadderAt(voiceOf(near).threat), 'the near end is not the ladder reading the frame')
  // and the finale, reached the honest way, still wins over the creature being close
  game.state = { ...game.state, finale: true }
  game.update(DT)
  assert.equal(audioModule.musicVoice(audio.lastFrame).level, 0, 'a close creature overrode the finale')
})

check('the note stream is the world\'s, and the finale takes it with it', () => {
  game.restart()
  game.start()
  run(game, 1.2)
  // the pure schedule, asked for the seed this world is actually running
  const schedule = audioModule.ambienceStream('motif', game.seed, 8)
  assert.ok(schedule.length >= 3, 'the schedule is empty')
  // the world's own played frames, replayed through the real cursor machine: only
  // frames the router sent the row on may advance it, which is the pause property
  // pass 13 established, applied to the music's own stream
  const manager = new audioModule.AudioManager()
  manager.setSeed(game.seed)
  const played = []
  let routedFrames = 0
  let playedSeconds = 0
  for (let i = 0; i < 60 * 40; i += 1) {
    const routed = audioModule.routeAudio(audio.lastFrame)
    if (routed.length > 0) {
      routedFrames += 1
      playedSeconds += DT
      const cue = routed.find((entry) => entry.id === 'musicMotif')
      manager._advanceAmbience('motif', DT, (event) => played.push(event))
      // the note that WOULD be played on this frame, from this frame's own cue
      const next = audioModule.musicMotifVoice(schedule[0], cue.params)
      assert.ok(next.level <= audioModule.MUSIC_MOTIF.level, 'a note was louder than a note')
    }
    game.update(DT)
  }
  assert.ok(routedFrames > 60 * 30, 'the world stopped routing the music, so this check proved nothing')
  assert.ok(
    Math.abs(manager.ambience.get('motif').clock - playedSeconds) < 1e-9,
    'the motif clock is not the played time',
  )
  assert.deepEqual(
    played,
    schedule.filter((event) => event.at <= playedSeconds).slice(0, played.length),
    'the music did not play the schedule the world\'s own clock produced',
  )
  assert.ok(played.length >= 1 && played.length <= 4, `${played.length} notes in 40 s of play is a rhythm, not an event`)
  // the finale, the same machine and the same frames: the cursor stops where it stood
  // rather than advancing, so a run that ends in the finale does not fire its backlog
  game.state = { ...game.state, finale: true }
  const held = manager.ambience.get('motif').clock
  const before = played.length
  for (let i = 0; i < 60 * 20; i += 1) {
    const cue = audioModule
      .routeAudio({ ...audio.lastFrame, finaleEnraged: true })
      .find((entry) => entry.id === 'musicMotif')
    if (cue.params.playing === true && cue.params.silent !== true && cue.params.motif > 0) {
      manager._advanceAmbience('motif', DT, (event) => played.push(event))
    }
    game.update(DT)
  }
  assert.equal(manager.ambience.get('motif').clock, held, 'the finale advanced the music clock')
  assert.equal(played.length, before, 'a note was scheduled into the silence')
})

// ---------------------------------------------------------------------------
// ITERATION 2, PASS 14 — ADDED BY THE REVIEW
// ---------------------------------------------------------------------------
//
// Four claims the pass states in prose and in its own commit message, and holds
// nowhere in this file. All four are about things only a REAL WORLD can show,
// which is why they are here and not in `verify.mjs`:
//
//   1. **A STAGGER MUST NOT PULSE THE SILENCE BACK.** The pass's message says it
//      ran this as an ad-hoc mutant ("the latch read off the creature's state
//      string") — a mutant with no committed check behind it is a story, and the
//      first pass to retune `_audioFrame` would have found nothing. §7.4's
//      connected swing puts the creature into `stagger` for 1.5 s, and §10.2
//      says that is a re-emergence DELAY and not a phase: the finale is still
//      running, so the music is still cut, and a pad that came back for it would
//      be a pulse the player cannot predict.
//   2. **THE PROGRESSION IS FROZEN BY A PAUSE.** The block above proves the world
//      stops handing over facts; this one proves the number the chord is a
//      function of stopped too, over five real minutes of pause.
//   3. **THE PROGRESSION IS ON THE WORLD'S CLOCK.** `world.js` is the only file
//      that decides what `frame.time` is, and no pure check can see it. This one
//      is deliberately a SOURCE read, because a claim about a line in `world.js`
//      asserted only by behaviour survives a well-behaved substitute — and a
//      substitute that hands the audio its own `performance.now()` is precisely
//      the bug the block above was written to catch.
//   4. **DETERMINISM ACROSS TWO WORLDS**, run against run rather than check
//      against itself.
// ---------------------------------------------------------------------------

check('a STAGGER in the finale does not pulse the silence back (§7.4, §10.2)', () => {
  game.restart()
  game.start()
  run(game, 1.2)
  game.creature = beast.createCreature({ state: 'stalk', awareness: 0 })
  game.state = { ...game.state, finale: true }
  game.update(DT)
  assert.equal(audio.lastFrame.finaleEnraged, true, 'the world did not report the finale')
  assert.equal(audioModule.musicVoice(audio.lastFrame).level, 0, 'the music is playing in the finale')
  // every posture the creature can be in, in the order §7.4 reaches them. The
  // stagger is written THREE times with a live recoil, so a gate that sampled it
  // once would miss a world whose stagger only lasts a frame or two.
  for (const state of ['stagger', 'stalk', 'chase', 'dormant', 'reposition', 'enraged', 'stagger', 'stagger']) {
    game.creature = { ...game.creature, state, staggerSeconds: 1.4, finale: true }
    game.state = { ...game.state, finale: true }
    game.update(DT)
    const voice = audioModule.musicVoice(audio.lastFrame)
    assert.equal(audio.lastFrame.finaleEnraged, true, `the world dropped the finale on ${state}`)
    assert.equal(voice.silent, true, `a ${state} creature un-silenced the music in the finale`)
    assert.equal(voice.level, 0, `a ${state} creature brought the pad back in the finale`)
    assert.equal(voice.hiss, 0, `a ${state} creature brought the hiss back in the finale`)
    assert.equal(voice.motif, 0, `a ${state} creature scheduled a note in the finale`)
  }
  // and the flag LATCHES across the capture, which is §9.1's half and the reason
  // the latch is a flag rather than a posture
  game.state = { ...game.state, finale: true }
  game.creature = beast.createCreature({ state: 'stagger', staggerSeconds: 0.5 })
  game.store.update((state) => ({ ...state, phase: 'reset' }))
  for (let i = 0; i < 20; i += 1) game.update(DT)
  assert.equal(audio.lastFrame.started, true, 'the black did not hand the audio a frame')
  assert.equal(audio.lastFrame.finaleEnraged, true, 'the finale did not survive the black')
  assert.equal(audioModule.musicVoice(audio.lastFrame).level, 0, 'the pad came back for the black')
})

check('the progression is frozen by a pause, over five real minutes of one', () => {
  game.restart()
  game.start()
  run(game, 3.4)
  // The chord is a function of the world's CLOCK, and the clock is `animTime` — so
  // the claim is about `animTime`, not about what the paused frame carried. A
  // paused world hands the audio `{ started: false }` and no facts at all, so
  // reading `lastFrame.time` there is reading nothing, which is the trap the block
  // above documents at length.
  const before = audioModule.musicChordAt(game.animTime, game.seed)
  const clock = game.animTime
  game.setPaused(true)
  for (let i = 0; i < 60 * 300; i += 1) game.update(DT)
  assert.equal(game.animTime, clock, 'the world clock moved over five minutes of pause')
  assert.equal(audio.lastFrame.started, false, 'a paused world still handed the audio a frame of facts')
  assert.deepEqual(
    audioModule.musicChordAt(game.animTime, game.seed),
    before,
    'the progression moved under the pause card',
  )
  game.setPaused(false)
  run(game, 6)
  assert.ok(
    audioModule.musicChordAt(game.animTime, game.seed).step > before.step,
    'the progression did not resume',
  )
})

check('the world hands the music its own clock, and the LATCHED finale flag', () => {
  // The only claims about the music that live in `world.js` rather than `audio.js`,
  // so they are read off the source rather than inferred from behaviour.
  const source = readFileSync(new URL('./src/game/world.js', import.meta.url), 'utf8')
  const at = source.indexOf('  _audioFrame() {')
  const end = source.indexOf('\n  }', at)
  const body = source.slice(at, end < 0 ? source.length : end)
  assert.match(body, /time: this\.animTime/, "the music is not on the world's clock")
  assert.match(body, /finaleEnraged: this\.state\.finale === true/, 'the music is not on the latched flag')
  assert.equal(
    /finaleEnraged:[^,\n]*creature/i.test(body),
    false,
    "the music is reading the creature's posture rather than the flag",
  )
  // and §14.3's "completely": the pause returns before `animTime` moves, which is
  // the reason the check above has a chord to freeze at all
  const up = source.indexOf('  update(dt) {')
  const paused = source.slice(up, up + 900)
  assert.ok(
    paused.indexOf('if (this.paused) {') >= 0 && paused.indexOf('this.animTime += dt') > paused.indexOf('return'),
    '§14.3 does not freeze the clock before the audio is updated',
  )
})

check('two worlds of one seed hear the same music, and two seeds do not', () => {
  const read = (w) => {
    w.restart()
    w.start()
    run(w, 2.5)
    const frame = w._audioFrame()
    const routed = audioModule.routeAudio(frame)
    // `time` is the WORLD's lifetime clock and `restart()` deliberately does not
    // rewind it, so it is not part of "the music" — the progression resumes where
    // the clock is, which is what "a pure function of the world's clock" means.
    // What must be identical is everything the music DECIDES from the frame, so
    // `time` is the one field taken back out.
    const { time, ...music } = routed.find((entry) => entry.id === 'music').params
    assert.ok(Number.isFinite(time), 'the world handed the music no clock at all')
    return JSON.stringify({
      music,
      motif: routed.find((entry) => entry.id === 'musicMotif').params,
      // the chord is compared at a FIXED time, not at each world's own: `time` is the
      // world's lifetime clock and the two worlds have been alive different lengths,
      // so their chords are legitimately at different points in the loop. What has to
      // agree is the KEY and the ROTATION — the same seed, read at the same instant.
      chord: audioModule.musicChordAt(120, w.seed).degrees,
    })
  }
  const first = read(game)
  // A SECOND world on the same store, the way the blocks above build one, so the
  // comparison is run-against-run rather than check-against-itself.
  const second = new BellLoopGame(container, { store, audio, createRenderer: makeFakeRenderer })
  const mirror = read(second)
  second.dispose()
  assert.equal(first, mirror, 'the same seed heard the same music twice')
  // ...and the determinism is not the trivial kind, where every run sounds the same
  assert.notEqual(
    JSON.stringify(audioModule.ambienceStream('motif', 4242, 12)),
    JSON.stringify(audioModule.ambienceStream('motif', 1337, 12)),
    'two seeds heard the same notes at the same times',
  )
})

let failed = 0
for (const entry of checks) {
  if (!entry.ok) failed += 1
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
  if (!entry.ok) console.log(`        ${entry.error}`)
}
console.log(`\n${checks.length - failed}/${checks.length} world checks passed`)
if (failed > 0) process.exitCode = 1
