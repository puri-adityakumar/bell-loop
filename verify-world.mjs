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
    assert.ok(hits.length > 0, `${where}: there is nothing at all between a camera on the stand-off and the gate`)
    const first = hits[0].object
    assert.ok(
      [portal.disc, portal.rim, ...portal.swirl].includes(first),
      `${where}: the first thing a camera sees is ${first.name || first.type}, not the gate — the shell is in front of its own opening`,
    )
    // ...and it stops at the opening rather than at the far side of the
    // structure: the gate plane is 4.5 m out and the lip is 2.8 cm of tube on it
    assert.ok(
      4.4 < hits[0].distance && hits[0].distance < 4.55,
      `${where}: the camera is stopped ${hits[0].distance.toFixed(2)} m out, which is not the gate plane at 4.50 m`,
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
