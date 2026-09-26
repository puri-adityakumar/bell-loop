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
  // §9.3's black is the only fade v2 has, and it belongs to the capture. BEGIN
  // lifts the *title* black, which is `start()`'s own `fade = 1`; after four
  // seconds of a running clock, `_updatePlaying` never touches `fade` again, so
  // what the HUD mirror reads is whatever the last setter left there. The
  // assertion that means something is that the store agrees with the world, not
  // that it equals a number v2 no longer has.
  assert.equal(store.get().fade, game.fade, 'the mirrored fade and the world\'s own must agree')
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
  assert.ok(game.creatureView.pose.presence < 0.3, 'and it is the dim one')
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
  game.creaturePosition = { x: game.player.pos.x + 2, z: game.player.pos.z }
  game.creature = beast.createCreature({ state: 'stalk', banishCount: game.state.banishCount })
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
  game.creaturePosition = { x: game.player.pos.x + 30, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x, z: game.player.pos.z }
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
  const canonicalPlayer = {
    x: game.player.pos.x - game.streetView.origin.x,
    z: game.player.pos.z - game.streetView.origin.z,
  }
  game.creaturePosition = { x: canonicalPlayer.x + 40, z: canonicalPlayer.z }
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
  game.creaturePosition = { x: game.player.pos.x + 8, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 1, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + beast.BANISH_RANGE + 2, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 4, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 5, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 30, z: game.player.pos.z }

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
      view.ring.material,
      game.streetView._materials.portalDead,
      `${entry.id} is still wearing the live material`,
    )
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
  game.creaturePosition = { x: game.player.pos.x + 150, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 1.6, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 150, z: game.player.pos.z }
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
  game.creaturePosition = { x: game.player.pos.x + 4, z: game.player.pos.z }
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
  // and it is idempotent, because `dispose` may legitimately be called twice on
  // the way out of a hot reload
  game.dispose()
  game.update(0.1)
})



let failed = 0
for (const entry of checks) {
  if (!entry.ok) failed += 1
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
  if (!entry.ok) console.log(`        ${entry.error}`)
}
console.log(`\n${checks.length - failed}/${checks.length} world checks passed`)
if (failed > 0) process.exitCode = 1
