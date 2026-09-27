/**
 * main.jsx — the capture page (v2 slice 16).
 *
 * WHAT THIS IS
 * ------------
 * `capture.html` in a headless Chrome, the fourteen §16.5 views, and a
 * photographer. The views themselves are `src/game/capture.js` (pure, and
 * asserted by `verify.mjs`); the step list is the only thing this file
 * interprets; `tools/capture.mjs` is what asks the page to take them and writes
 * the PNGs.
 *
 * WHY A SEPARATE PAGE INSTEAD OF A FLAG ON THE GAME
 * --------------------------------------------------
 * Because the game object is the whole difficulty and it is, correctly, private:
 * `App.jsx` keeps it in a ref and hands it to nobody. Exposing it on `window` for
 * the screenshotter would put a test hook in shipped code, and the cheapest
 * version of that hook is the one that stays. So the harness builds its own world
 * out of the same modules — the real `LongQuietGame`, the real `Hud`, the real
 * overlays, the real stylesheet — and the only thing it does not share with
 * `App.jsx` is the twenty lines of shell at the top. `verify.mjs` greps both files
 * for the same overlay conditions, so the copy cannot drift silently.
 *
 * WHAT IS NEVER FAKED
 * -------------------
 * The verbs below do what a player does: `begin` is the START button's call, a
 * hold is a held key, a shutdown is a real 1.2 s commit through
 * `rules.applyPortalHold`, a capture is the world's own `_capture()`, and a win is
 * the world's own `_win()` firing off §10.4's geometry. Exactly two things are
 * written directly, and both are said out loud in `capture.js`: the creature's
 * §6.1 state and where it is stood, because a hunter cannot be walked into a
 * screenshot on demand, and the camera, because a photographer picks a viewpoint.
 *
 * THE CLOCK IS STEPPED, NOT WAITED FOR
 * ------------------------------------
 * `wait` used to sit in `requestAnimationFrame` and watch `animTime`, which is
 * correct on a GPU and wrong on the machine this actually runs on. `world.js`
 * clamps its frame to `Math.min(clock.getDelta(), 0.05)`, and SwiftShader at
 * 1280x720 renders this street at 0.95 frames a second once a run has started
 * (measured: 2.46 fps behind the title card, 0.95 fps in the street), so each
 * rendered frame is credited a twentieth of a second of world time and the clock
 * advances at 0.047x realtime. A `wait(0.6)` then wanted 13 s of wall clock and
 * its own 20x guard gave it 12 — which is the "the world's clock is not
 * advancing" failure that took twelve of the fourteen views down with it.
 *
 * So a wait steps the world instead: `game.update(SIM_DT)` in a loop, which is
 * `world.js`'s own door and the same one `verify-world.mjs` drives, at the frame
 * a 60 Hz display would have handed it. 0.238 ms a step, so the longest wait in
 * the set costs about 25 ms of wall clock and no view is paced by the renderer
 * any more. Nothing is drawn during a wait — the picture is taken from the
 * world's own renderer at the end, from the state the steps left behind.
 *
 * A wait the world refuses to run is still a failure, and now it says so: under
 * §14.3's pause `update` returns before the clock moves at all, so `wait` there
 * throws `the world is paused` immediately instead of burning its whole ceiling
 * discovering a frozen clock. That is why the pause view photographs itself with
 * `frames` and reports `simFrozen` rather than waiting (§16.5's "completely
 * frozen simulation" is a number in the report, not a timeout that expired).
 *
 * If a step cannot be taken, this throws. There is no fallback state and no
 * "close enough" — a view that fails is a hole in the gallery, and the harness
 * records the hole instead of covering it.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
// `THREE` for the probe's own vectors. The page is capture-only and already
// builds a world out of Three.js, so this costs no bundle weight and keeps
// `sightline` from reimplementing a projection three.js already owns.
import * as THREE from 'three'
import { LongQuietGame } from '../src/game/world.js'
import { createStartStore, PHASE } from '../src/game/store.js'
import { hudSnapshot } from '../src/ui/hud.js'
import * as beast from '../src/game/creature.js'
import * as hood from '../src/game/neighborhood.js'
import * as rules from '../src/game/rules.js'
import {
  viewById,
  STREET_NODE,
  FURNITURE_FAMILIES,
  FURNITURE_POOLS,
  FURNITURE_MIN_LEGIBLE_PX,
  // pass 15. The probe's two box geometries, read from the same table the steps
  // come from: the rows the shimmer is measured over, and the reference band the
  // creature's own effect on the street lighting is divided out against. A page
  // that owned either number would be a second staging, and a second staging is
  // what the probe's own header exists to prevent.
  PROBE_BAND_ROWS,
  PROBE_REFERENCE_INNER,
  PROBE_REFERENCE_OUTER,
} from '../src/game/capture.js'
import Hud from '../src/ui/Hud.jsx'
import PauseOverlay from '../src/ui/PauseOverlay.jsx'
import StartOverlay from '../src/ui/StartOverlay.jsx'
import WinOverlay from '../src/ui/WinOverlay.jsx'
import '../src/index.css'
import '../src/ui/styles.css'

/**
 * The frame a wait steps at, in seconds: what `world.js` hands `update` on a
 * 60 Hz display, and comfortably inside its own 0.05 s clamp.
 *
 * The shipped loop's clamp is the reason this number has to be named rather than
 * inherited. At 1 fps a clamped frame hands the simulation a twentieth of a
 * second, and the world runs twenty times slow — which is a correct thing for a
 * game to do about a machine that cannot keep up, and the wrong thing for a
 * capture harness to inherit. §16.5's beats are wall-clock facts about the design
 * ("0.8 s into a 1.2 s hold"), so they are measured in the world's own units and
 * driven at the rate the design assumes.
 */
const SIM_DT = 1 / 60

/**
 * How long `begin` waits for the world to finish its opening dissolve, in world
 * seconds. `world.js` lifts `fade` at 0.7/s, so BEGIN's black is gone at 1.43 s
 * and this is that with a margin.
 *
 * It is a wait and not a handful of frames because the whole point is world time:
 * a rendered frame on this machine is worth a twentieth of a second of it, so
 * waiting for the fade by frames means waiting for a *slow machine's* idea of
 * when the fade is over, and the measured result was 0.405 — every frame of the
 * whole gallery photographed through a 40%-opaque black rectangle, which is why
 * a street with working sodium lamps in it still read as `mean luma 7.6`.
 */
const BEGIN_SETTLE_SECONDS = 1.5

/**
 * How many steps run between yields back to the page.
 *
 * Small enough that React's scheduler, the store's subscribers and the world's
 * own render loop all get a turn inside a wait; large enough that the yields are
 * not the cost. At `SIM_DT` the whole set's waits come to a few hundred steps.
 */
const STEPS_PER_YIELD = 16

/**
 * How much slower than real time a wait may run before it calls itself stuck.
 *
 * A stepped wait is CPU-bound, so this is no longer a statement about the
 * renderer — it is the guard against a wait that cannot finish at all, which is
 * what a paused or disposed world looks like from in here. Generous because the
 * container this was written on is slow, and because a false "stuck" costs a
 * whole view.
 */
const WAIT_SLOWDOWN_ALLOWANCE = 20

/**
 * A hard cap on any single wait, so a bug cannot hang the harness forever.
 *
 * The cap exists to turn "the world is frozen" into an error, not to enforce a
 * budget: every wait in §16.5's set now finishes in under a tenth of a second
 * of wall clock, and a wait that reaches this ceiling is a real bug rather than
 * a slow machine.
 */
const WAIT_CEILING_SECONDS = 45

function Shell({ worldRef, onReady }) {
  const containerRef = useRef(null)
  const [store] = useState(() => createStartStore())
  const [hud, setHud] = useState(() => hudSnapshot(store.get()))

  useEffect(() => {
    const built = new LongQuietGame(containerRef.current, { store })
    worldRef.current = built
    onReady(built, store)
    const unsubscribe = store.subscribe((state) => setHud(hudSnapshot(state)))
    return () => {
      unsubscribe()
      built.dispose()
      worldRef.current = null
    }
  }, [store, onReady, worldRef])

  // the same three overlay conditions as `App.jsx`, and the only thing in this
  // file that duplicates rather than shares
  return (
    <div className="app">
      <div className="scene" ref={containerRef} />
      <Hud hud={hud} />
      {hud.phase === PHASE.START ? <StartOverlay onBegin={() => {}} /> : null}
      {hud.paused ? (
        <PauseOverlay reducedMotion={hud.reducedMotion} onResume={() => {}} onToggleMotion={() => {}} />
      ) : null}
      {hud.phase === PHASE.WON ? <WinOverlay onRestart={() => {}} /> : null}
    </div>
  )
}

const worldRef = { current: null }
let game = null
let store = null

createRoot(document.getElementById('root')).render(
  <Shell
    worldRef={worldRef}
    onReady={(built, builtStore) => {
      game = built
      store = builtStore
      // the harness's handle on the world, for diagnosing a view that will not
      // take. Never true of the shipped game: this page is not in the bundle.
      window.__captureGame = built
      window.__captureReady = true
    }}
  />,
)

/** One rendered frame. Everything here is paced on the world's own clock. */
function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function frames(count) {
  for (let index = 0; index < count; index += 1) await frame()
}

/**
 * holdLoop / releaseLoop — the world's render loop, off and on. PASS 15.
 *
 * The loop is the one thing on this page that can move the world between two
 * shutters. `_animate` hands `update` `Math.min(clock.getDelta(), 0.05)`, so a
 * loop that is running while a picture is being read is a world that has taken a
 * clamped frame since that picture was drawn — and a shutter is about a second of
 * wall clock at this renderer's rate, which is one or two of those on its own.
 *
 * So the probe's loop is held for the whole of a frame: from the last frame the
 * creature is drawn in, through the shutter, through the removal, and through the
 * baseline's own shutter. `holdLoop` cancels `game.rafId`, which is the NEXT
 * frame's id, so it stops the world on the frame just drawn rather than between
 * two of them.
 *
 * `releaseLoop` is the only place on this page that re-arms the loop, and `run`
 * calls it at the TOP rather than leaving a run responsible for putting it back.
 * A run handed a held loop that does not notice would draw its first frames from
 * a stopped world and the picture would be right by accident.
 */
let loopHeld = false
// the world clock of the last frame a probe frame was drawn in, carried from
// `run` to `__captureBaseline` so the control is stamped against the clock of the
// picture it is a control for rather than against the moment it was taken. 0 means
// no frame has been shuttered from this page, and the baseline says so.
let shutterTime = 0

function holdLoop() {
  if (loopHeld) return
  cancelAnimationFrame(game.rafId)
  loopHeld = true
}

function releaseLoop() {
  if (!loopHeld) return
  loopHeld = false
  // measured from now and not from the frame that was held: the world gets the
  // first frame it would have had if the loop had never been stopped, rather
  // than 0.05 s of shutter time it did not live through.
  game.clock.oldTime = performance.now()
  game.rafId = requestAnimationFrame(game._animate)
}

/**
 * wait — let the world advance by `seconds` of its own time.
 *
 * Measured on `animTime` rather than on a frame count, because §14.3's pause
 * freezes it and a software renderer runs at a tenth of a GPU's rate: a
 * frame-counted wait photographs a different moment on every machine, which is
 * the one thing a capture set cannot be.
 *
 * And *stepped* rather than watched, which is the difference between a gallery
 * and a wall of timeouts. The world's own render loop cannot be the clock here:
 * it clamps each frame to 0.05 s, and at SwiftShader's ~1 fps that is a clock
 * running at 0.047x realtime, so a `wait` paced on frames burned twelve seconds
 * of wall clock per view and then called the world frozen. Calling `update`
 * directly is the same door `verify-world.mjs` drives, with the world's own
 * rules, its own state machine and its own `animTime` — the harness supplies the
 * frame, and nothing else.
 *
 * The wall clock is a guard, so a world that will not run at all throws here
 * rather than hanging the harness. §14.3's pause is the case that matters: it
 * returns from `update` before the clock moves, so a wait on a paused world can
 * never finish and is rejected up front instead of discovering the freeze the
 * slow way.
 */
async function wait(seconds) {
  if (!(seconds > 0)) return
  if (game.paused) throw new Error('wait: the world is paused, and §14.3 freezes its clock')
  const started = game.animTime
  const wallStart = performance.now()
  const ceiling = Math.min(WAIT_CEILING_SECONDS, seconds * WAIT_SLOWDOWN_ALLOWANCE) * 1000
  let sinceYield = 0
  while (game.animTime - started < seconds) {
    game.update(SIM_DT)
    if (performance.now() - wallStart > ceiling) {
      throw new Error(`wait(${seconds}) never completed: the world's clock is not advancing`)
    }
    // hand the page back every so often, so a long wait cannot starve React's
    // scheduler or the store's subscribers of the frames they mirror from
    sinceYield += 1
    if (sinceYield >= STEPS_PER_YIELD) {
      sinceYield = 0
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  await frame()
}

/** The copy of a canonical anchor that is currently drawn around the player. */
function worldAnchor(canonical) {
  return game.streetView.worldOfNear(canonical, game.player.pos)
}

/** Where a named target is, as a canonical anchor position a view can stand at. */
function anchorFor(target, id) {
  const street = game.streetView
  switch (target) {
    case 'spawn':
      return hood.SPAWN.position
    case 'node':
      return hood.streetNodeToWorld(hood.streetNodeId(STREET_NODE.ax, STREET_NODE.az))
    case 'avenue':
      // The same intersection, and the reason it is a target of its own: a
      // composition that wants the *street* rather than anything on it. The lamp
      // grid is one lamp per intersection at `node + (7.6, 7.6)` — off the
      // corner of the pavement, not over the road — so a camera that stands well
      // back on the road axis looks past two lamp heads into the row beyond, and
      // `place` is then asked for a specific bearing rather than left to search.
      return hood.streetNodeToWorld(hood.streetNodeId(STREET_NODE.ax, STREET_NODE.az))
    case 'lamp': {
      // The sodium lamp on that same intersection, found rather than recomputed.
      //
      // §12.1's pool is twelve metres across and the lighting gate measures the
      // lower half of the frame, so "stand near a streetlight" is a composition
      // with a number attached: the subject is the pool of light on the road, and
      // the camera has to be close enough for that pool to reach under it. The
      // offset is read out of `streetView`'s own records instead of being written
      // down here, because a second copy of "7.6 m off the corner" is a second
      // thing that can be wrong about where the lamps are.
      const node = hood.streetNodeToWorld(hood.streetNodeId(STREET_NODE.ax, STREET_NODE.az))
      const near = street.lampsNear(node.x, node.z, 24)
      if (near.length === 0) throw new Error('no lamp near the street node')
      return { x: near[0].x, z: near[0].z }
    }
    case 'hammer':
      return street.hammer.position
    case 'portal': {
      const entry = id ? street.portals.find((portal) => portal.id === id) : street.portals[0]
      if (!entry) throw new Error(`no portal ${id ?? '(default)'}`)
      return entry.position
    }
    case 'exit':
      return street.exitCar.anchor.position
    default:
      throw new Error(`unknown capture target: ${target}`)
  }
}

/** Is this spot inside something solid? The player's own colliders, already grown. */
function blocked(x, z) {
  for (const box of game.player.colliders) {
    if (x <= box.minX || x >= box.maxX || z <= box.minZ || z >= box.maxZ) continue
    return true
  }
  return false
}

/** Yaw that faces `to` from `from`. Yaw 0 looks down -Z, as `player.js` has it. */
function yawToward(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

/**
 * place — a stand-off position `back` metres from a target, looking at it.
 *
 * Sixteen candidate bearings, and the first one that is neither inside a wall nor
 * blind to the target wins. This is the photographer's one liberty and it is
 * worth spelling out: a capture that stands the camera at a fixed offset from a
 * procedural anchor is a capture of a wall roughly half the time, because the
 * anchors sit in lots and the player cannot stand in a lot. Searching for a
 * viewpoint that can actually see its subject is what lets the same script work
 * on a different seed.
 * The search is right for a *subject* and wrong for a *street*, and the two are
 * now separated by which one they use. Standing off a subject at 2-4 m puts the
 * camera close enough that the subject fills the frame, which is the whole point
 * of photographing a hammer or a portal. Standing off a street node at the same
 * distances is the composition that produced this slice's first gallery: the
 * camera ended up 9 m from the intersection with the sodium lamp 7.6 m to one
 * side and 1.4 m ahead of it — 79.6° off the view axis, outside the frustum — so
 * the frame held a lit horizon, a row of unlit house silhouettes, and not one
 * streetlight. A lamp is legible when it is *down the road ahead*, and that is a
 * bearing and a distance rather than a search, which is what `avenue` is for.
 */
function place(target, back, id, bearing) {
  const anchor = worldAnchor(anchorFor(target, id))
  if (!(back > 0)) return { x: anchor.x, z: anchor.z, yaw: 0 }
  if (bearing !== undefined) {
    // An asked-for bearing is taken or refused, never searched around: a
    // photographer who says "from here" and is quietly moved somewhere else is
    // worse off than one whose shot is refused outright.
    const radians = (bearing * Math.PI) / 180
    const spot = { x: anchor.x + Math.sin(radians) * back, z: anchor.z + Math.cos(radians) * back }
    if (blocked(spot.x, spot.z)) {
      throw new Error(`the ${bearing}° stand-off ${back} m from ${target} is inside something solid`)
    }
    if (!beast.lineOfSight(spot, anchor, game.streetView.occluders())) {
      throw new Error(`the ${bearing}° stand-off ${back} m from ${target} cannot see it`)
    }
    return { x: spot.x, z: spot.z, yaw: yawToward(spot, anchor) }
  }
  const occluders = game.streetView.occluders()
  // The side of the subject the camera is allowed to approach from, when the
  // subject has one. A portal is a doorway in a shed: the stand-off search would
  // otherwise take bearing 0 and photograph the back panel, which is exactly what
  // the §16.5.5 view did at 0.33% lit. `streetView` knows which way each shell
  // opens, and a search that starts there finds an opening view without this
  // file needing to know what a bus shelter is.
  const approach = target === 'portal' ? approachOf(target, id) : null
  const start = approach === null ? 0 : Math.atan2(approach.x, approach.z)
  for (let step = 0; step < 16; step += 1) {
    const radians = start + (step / 16) * Math.PI * 2
    const spot = { x: anchor.x + Math.sin(radians) * back, z: anchor.z + Math.cos(radians) * back }
    if (blocked(spot.x, spot.z)) continue
    if (step >= 2 && !beast.lineOfSight(spot, anchor, occluders)) continue
    return { x: spot.x, z: spot.z, yaw: yawToward(spot, anchor) }
  }
  throw new Error(`no stand-off point ${back} m from ${target}${id ? `:${id}` : ''} can see it`)
}

/** The unit direction a named target is approached from, or `null` for "any side". */
function approachOf(target, id) {
  const street = game.streetView
  if (target === 'portal') {
    const entry = id ? street.portals.find((portal) => portal.id === id) : street.portals[0]
    if (!entry) throw new Error(`no portal ${id ?? '(default)'}`)
    return entry.facing
  }
  return null
}

function teleport(spot) {
  game.player.teleport(spot.x, spot.z, spot.yaw)
  game._recentre()
  game._refreshColliders()
}

/**
 * Hold `KeyE` for `seconds`, the way §5.2 is meant to be played.
 *
 * Returns the hold fraction reached, sampled before the key comes back up. That
 * return value is the only evidence that the key was held against *something*:
 * `world.js` hands `applyPortalHold` an `active: false` for every portal the
 * player is not standing next to, and decays the progress, so a hold played
 * from outside `streetView.portalRange` is indistinguishable from no hold at
 * all except by its progress reading zero.
 */
async function hold(seconds) {
  game.player.pressKey('KeyE')
  try {
    await wait(seconds)
    return game._hold
  } finally {
    game.player.releaseKey('KeyE')
  }
}

/** §5.2's hammer hold is the same verb, so the pickup is the same hold. */
async function takeHammer() {
  teleport(place('hammer', 0))
  await hold(rules.PORTAL_SHUT_SECONDS + 0.35)
  if (game.state.hammerHeld !== true) {
    throw new Error('takeHammer: the pickup did not fire — the player was never in reach')
  }
  await frames(1)
}

/** One §5.2 shutdown, start to finish, and an assertion that it took. */
async function shutPortal(id) {
  teleport(place('portal', 2.2, id))
  await frames(1)
  if (game.streetView.nearestPortal(game.player.pos)?.id !== id) {
    throw new Error(`shut(${id}): the portal is out of reach from the stand-off point`)
  }
  await hold(rules.PORTAL_SHUT_SECONDS + 0.25)
  if (game.state.portals[id] !== true) {
    throw new Error(`shut(${id}): the hold completed without shutting the portal`)
  }
  await frames(1)
}

/** All three, in `neighborhood.js`'s own order, with the world between them. */
async function shutAll() {
  for (const id of hood.PORTAL_IDS) await shutPortal(id)
  if (game.state.finale !== true) {
    throw new Error('shut: three portals are down and the finale has not latched')
  }
}

/**
 * placeCreature — write the creature's §6.1 state and stand it in the drawn frame.
 *
 * The one place this file writes simulation state, and both halves of it are
 * deliberate. `creaturePosition` is CANONICAL (world.js's own note, and the cause
 * of two frame bugs in slices 14 and 15), so a position computed in the drawn
 * frame has the street's origin taken out of it before it is stored. And the
 * re-emergence clock is pushed past its own fade so the figure is fully present:
 * §8.3's fade exists so that a teleport reads as an arrival, and a capture is not
 * an arrival.
 *
 * ITERATION 2, PASS 15 — `staggerSeconds`. §7.4's recoil clock, and a
 * `stagger` without one is not a `stagger`: `creatureStep` reads a spent clock
 * as a finished banish, puts the creature `dormant` and forgets it, and the
 * shutter would photograph a street with nothing in it under a filename that
 * says otherwise. The probe's five-row set needs the row, and the recoil IS part
 * of that row's presentation (`RECOIL` is read off the clock in
 * `creaturePose`), so the clock is a field of this step rather than a second verb
 * that sets half a state and leaves the other half to the AI.
 *
 * BEFORE: `{state, metres, bearing}`. AFTER: `staggerSeconds` as a fourth field,
 * where `0` means "leave the clock alone" — the honest reading for the four rows
 * that never read it, and the reason `capture.js` writes the field on every
 * `creature` step rather than only on the stagger's: a step whose shape depends
 * on which row it is staging is two shapes to keep in step.
 */
function placeCreature({ state, metres, bearing = 0, staggerSeconds = 0 }) {
  const yaw = game.player.yaw + (bearing * Math.PI) / 180
  const drawn = {
    x: game.player.pos.x - Math.sin(yaw) * metres,
    z: game.player.pos.z - Math.cos(yaw) * metres,
  }
  const origin = game.streetView.origin
  game.creaturePosition = { x: drawn.x - origin.x, z: drawn.z - origin.z }
  game.creature = {
    ...game.creature,
    state,
    awareness: state === 'chase' || state === 'enraged' ? 1 : 0.45,
    chaseSeconds: 0,
    banishCount: game.state.banishCount,
    tier: rules.portalsShut(game.state.portals),
    // spread LAST and only when it is a real number, because the counter is
    // §7.4's own and a zero written over a live one would end the banish the
    // field exists to stage
    ...(Number.isFinite(staggerSeconds) && staggerSeconds > 0 ? { staggerSeconds } : {}),
  }
  game.dismissing = false
  game.dismissElapsed = 0
  game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
  game.banishElapsed = 0
}

/** One number to four places, or `null`. The report is read by a machine. */
function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null
}

/**
 * where — where the creature's HEAD is in this frame, in pixels, and how big a
 * metre is at that depth.
 *
 * ITERATION 2, PASS 15, and it exists because of a hole in the creature gate.
 * `findEyes` picks the brightest compact blob in the frame and `creatureContrast`
 * then measures the body under it — so every number that gate produces is a
 * statement about WHENEVER THAT BLOB IS. Passes 5-12 added lit windows to
 * distant houses, and a 12x6 cream window in `hammer-located.png` now satisfies
 * every one of the finder's tests. Nothing in the pure harness can see that,
 * because the pure harness cannot see a frame.
 *
 * The world's own scene graph can. `creatureView.head`'s world position pushed
 * through the real camera is where the eye quad is by construction — the eyes are
 * 3 cm above the head's centre, a pixel and a bit at 17 m — so a probe frame's
 * anchor is checkable against the subject the harness staged, and a blob 200 px
 * away in a house window is a failed frame rather than a measurement.
 *
 * `pxPerMetre` is the camera's own right and up vectors, not the world's axes: a
 * metre measured along a world axis is foreshortened by however far the camera is
 * turned, and the shimmer's curtain bands are 0.40-0.59 m off the figure's axis,
 * which at 17 m is nine pixels. Nine pixels is worth measuring properly.
 */
function where(viewport) {
  const camera = game.camera
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
  const toPixels = (v) => ({
    x: (v.x * 0.5 + 0.5) * viewport.width,
    y: (-v.y * 0.5 + 0.5) * viewport.height,
  })
  const head = new THREE.Vector3()
  game.creatureView.head.getWorldPosition(head)
  const centre = toPixels(head.clone().project(camera))
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const across = toPixels(head.clone().add(right).project(camera))
  const above = toPixels(head.clone().add(up).project(camera))
  return {
    head: { x: round(centre.x), y: round(centre.y), depth: round(head.z) },
    pxPerMetre: { x: round(Math.abs(across.x - centre.x)), y: round(Math.abs(above.y - centre.y)) },
    metres: round(camera.position.distanceTo(head)),
    visible: game.creatureView.root.visible === true,
    ...column(viewport, centre.y, right),
  }
}

/**
 * column — where the shimmer's own curtains are in this frame, in pixels.
 *
 * ITERATION 2, PASS 15, and the third thing `where` reports, because the first
 * version of this probe put its two measurement boxes a fixed fraction of
 * `HAZE_HALF_WIDTH` either side of the creature's HEAD — and that measured empty
 * air for one of the five rows.
 *
 * THE COLUMN IS A CONE, NOT A CYLINDER. `hazeLayers` widens it from 0.72 of
 * `HAZE_HALF_WIDTH` at the floor to 1.28 at the top, so a box derived from the
 * constant straddles the hole in the low bands and overshoots the crest in the
 * high ones, by the same amount in opposite directions.
 *
 * AND IT STANDS ON THE GROUND WHILE THE HEAD IS ON §7.4's RECOIL. `RECOIL` throws
 * a staggering figure 1.35 m back and pitches it 0.43 rad, which carries the head
 * 2.80 x sin(0.43) = 1.17 m off the axis it is supposed to be over — 35 px at the
 * 17 m this probe stands at, in a box six pixels wide. The stagger's three samples
 * were photographing fog and reporting that a shimmer drawn there was missing.
 *
 * So the boxes come off the drawn geometry: `creatureView.hazeLayers` is the band
 * list `_presentHaze` wrote this frame, the band that straddles the head's own
 * height is found in it, and its own `inner`/`outer` are projected along the
 * camera's right vector. `HAZE_INNER_FRACTION` is never re-derived here.
 *
 * THE REFERENCE BOXES
 * -------------------
 * Two, the same rows, `PROBE_REFERENCE_INNER` 1.3 m to `PROBE_REFERENCE_OUTER`
 * 1.8 m off the axis: clear of the widest band the table can draw (0.83 m at
 * `enraged`'s 1.08 scale) by half again, and inside the lamp pool, so they see
 * the same change in the street lighting the band does.
 *
 * They are there because pass 11 gave the creature a SECOND effect on the light,
 * worth 8-12 luma over the whole picture: `lampPulse` scales the sodium lamps by
 * the eye-flare envelope, and a figure the harness has just placed has its flare
 * at the peak. The first version of this measurement read that as a shimmer.
 *
 * @param {{width: number, height: number}} viewport
 * @param {number} headRow the head's projected y, in pixels
 * @param {THREE.Vector3} right the camera's own right axis
 * @returns `{column, curtain, reference}` — or `column.on === false` and two empty
 *   box lists when no shimmer was drawn, which is a measurement failure and not a
 *   reason to measure somewhere else
 */
function column(viewport, headRow, right) {
  const view = game.creatureView
  const bands = view.hazeLayers
  if (!Array.isArray(bands) || bands.length === 0) {
    return { column: { on: false, reason: 'no shimmer was drawn this frame' }, curtain: [], reference: [] }
  }
  const haze = view.haze
  const axis = { x: haze.position.x, z: haze.position.z }
  const headWorld = new THREE.Vector3()
  view.head.getWorldPosition(headWorld)
  // the band the head is standing in, and the nearest one above if the head falls
  // between two (the bands overlap, so this is a choice and not a lookup)
  const band =
    bands.find((entry) => headWorld.y >= entry.y - entry.halfHeight && headWorld.y <= entry.y + entry.halfHeight) ??
    bands.reduce((nearest, entry) => (Math.abs(entry.y - headWorld.y) < Math.abs(nearest.y - headWorld.y) ? entry : nearest))
  const toPixels = (v) => ({
    x: (v.x * 0.5 + 0.5) * viewport.width,
    y: (-v.y * 0.5 + 0.5) * viewport.height,
  })
  // A metre sideways at this depth, as the picture sees it: a point a metre along
  // the camera's own right vector, projected. The axis's screen x is read at the
  // head's row and the radii as offsets from it, which is exact for an offset
  // perpendicular to the view axis and close enough over a 0.6 m band.
  const at = (metres) => toPixels(new THREE.Vector3(axis.x, headWorld.y, axis.z).addScaledVector(right, metres).project(game.camera))
  const origin = at(0)
  const perMetre = Math.abs(at(-1).x - origin.x)
  const y0 = headRow - PROBE_BAND_ROWS
  const y1 = headRow + PROBE_BAND_ROWS
  // The two edges, in the order the PICTURE has them. `sign` decides which way
  // round they fall: on the left of the axis the smaller radius is the LARGER x,
  // so ordering the radii instead of the coordinates hands the measurement a
  // rectangle with its corners the wrong way round, and `regionMean` refuses one —
  // correctly, and in a way that took a full probe run to find, because the right
  // half of the figure was the only half that was ever a rectangle.
  const side = (sign, inner, outer) => {
    const atInner = origin.x + sign * inner * perMetre
    const atOuter = origin.x + sign * outer * perMetre
    return {
      x0: round(Math.min(atInner, atOuter)),
      x1: round(Math.max(atInner, atOuter)),
      y0: round(y0),
      y1: round(y1),
    }
  }
  return {
    column: {
      on: true,
      axis: { x: round(axis.x), z: round(axis.z) },
      headRow: round(headRow),
      rows: { y0: round(y0), y1: round(y1) },
      band: { y: round(band.y), inner: round(band.inner), outer: round(band.outer) },
      widest: round(Math.max(...bands.map((entry) => entry.outer))),
      haze: round(view.pose ? view.pose.haze : 0),
    },
    curtain: [side(-1, band.inner, band.outer), side(1, band.inner, band.outer)],
    reference: [side(-1, PROBE_REFERENCE_INNER, PROBE_REFERENCE_OUTER), side(1, PROBE_REFERENCE_INNER, PROBE_REFERENCE_OUTER)],
  }
}

/**
 * poseReport — the pose the frame was taken with, read off the view itself.
 *
 * `creaturePose` is pure and `verify.mjs` can call it with a clock it chooses,
 * but the clock in a capture is the world's own and the numbers that reach the
 * screen are the ones `present` applied to a material. This is the link: the
 * per-state record in `benchmark/creature-probe.json` carries the alpha the
 * pixels were drawn with, so "the eye cleared the floor" and "the eye was asked
 * for at 0.8" are one measurement rather than two unrelated ones.
 */
function poseReport() {
  const pose = game.creatureView.pose
  if (!pose) return null
  return {
    state: pose.state,
    present: pose.present === true,
    scale: round(pose.scale),
    presence: round(pose.presence),
    eye: round(pose.eye),
    eyeSize: round(pose.eyeSize),
    eyeFlare: round(pose.eyeFlare),
    haze: round(pose.haze),
    redden: round(pose.redden),
    staggerLeft: round(game.creature.staggerSeconds),
    trail: game.creatureTrail ? game.creatureTrail.length : 0,
    puffs: game.creaturePuffs ? game.creaturePuffs.puffs.length : 0,
  }
}

/** §7.4: one press, and the world decides whether it connected. */
async function swing() {
  const before = game.state.banishCount
  game.player.pressKey('Mouse0')
  await frames(1)
  game.player.releaseKey('Mouse0')
  await frames(1)
  if (game.state.banishCount === before && game.creature.state !== 'dormant') {
    throw new Error('swing: nothing was banished and nothing was staggered — the figure was out of reach')
  }
}

/** §9.3: the world's own capture test, run honestly by standing in the way. */
async function caught() {
  placeCreature({ state: 'chase', metres: 0.5, bearing: 0 })
  await frames(2)
  if (store.get().phase !== PHASE.RESET) {
    throw new Error('caught: the creature was inside the capture radius and nothing happened')
  }
}

/** §10.4: inside the win trigger with the finale running, and the world decides. */
async function win() {
  const car = game.streetView.exitCar
  const anchor = worldAnchor(car.anchor.position)
  // Facing the way §10.3 throws its beam, which is the one place the whole
  // gallery's brightest light is. The run ends at the open driver's door, and
  // `car.centre` is 2.5 m away across the frontage, so looking *away* from it
  // puts the headlight wash on the pavement in front of the camera rather than
  // the unlit flank of a parked car. This was worth a comment because the win
  // view used to keep whatever yaw the last portal stand-off left behind, and
  // measured 5.74% lit facing a wall.
  const facing = yawToward(worldAnchor(car.centre), anchor)
  teleport({ x: anchor.x, z: anchor.z, yaw: facing })
  await frames(2)
  if (store.get().phase !== PHASE.WON) {
    throw new Error('win: standing in the exit with the finale running did not end the run')
  }
}

/** The whole vocabulary. `verify.mjs` reads this switch and fails on any drift. */
async function applyStep(step) {
  switch (step.op) {
    case 'begin':
      game.start()
      // The phase does not become PLAYING inside `start()`: `update()` is what reads
      // the store into `this.phase` and only then dispatches to `_updatePlaying`.
      // So the hand-off is stepped into place here, synchronously, rather than by
      // waiting for the render loop to notice — which on a software rasteriser is
      // a race this page should never be in, and which cost the previous run a
      // fade of 0.405 under every single view.
      game.update(SIM_DT)
      if (store.get().phase !== PHASE.PLAYING) {
        throw new Error('begin: the world did not enter PLAYING')
      }
      await wait(BEGIN_SETTLE_SECONDS)
      // and then the dissolve is actually finished, which is the invariant the
      // whole gallery rests on. Asserting it here means a regression in
      // `world.js`'s fade can no longer reach a PNG: a view fails loudly instead
      // of quietly writing another black rectangle into the gallery.
      if (game.fade > 0) {
        throw new Error(
          `begin: the screen is still ${game.fade.toFixed(3)} black after the settle — ` +
            'the opening dissolve is not finishing',
        )
      }
      break
    case 'goto':
      teleport(place(step.target, step.back, step.id, step.bearing))
      break
    case 'takeHammer':
      await takeHammer()
      break
    case 'shut':
      await shutAll()
      break
    case 'hold': {
      if (step.at) teleport(place(step.at.target, step.at.back, step.at.id, step.at.bearing))
      await frames(1)
      const reached = await hold(step.seconds)
      // The luma gate cannot see this. A hold played from outside
      // `portalRange` photographs a completely lit, entirely untouched world and
      // clears the floor comfortably, so the one check that catches it is that
      // the verb actually did something.
      if (!(reached > 0)) {
        throw new Error(
          `hold: ${step.seconds} s of KeyE reached a hold fraction of ${reached} — the ` +
            'player is not within reach of anything, so this frame would be the world ' +
            'untouched under a filename claiming an interaction',
        )
      }
      break
    }
    case 'swing':
      await swing()
      break
    case 'creature':
      placeCreature(step)
      break
    case 'caught':
      await caught()
      break
    case 'win':
      await win()
      break
    case 'pause':
      game.setPaused(true)
      // §14.3 freezes the clock, so the wait that follows can never move
      // animTime — give it rendered frames instead of simulation time.
      await frame()
      await frame()
      break
    case 'motion':
      game.setReducedMotion(step.on === true)
      break
    case 'wait':
      await wait(step.seconds)
      break
    case 'frames':
      await frames(step.count)
      break
    default:
      throw new Error(`unknown capture op: ${step.op}`)
  }
}

/**
 * sightline — how much pass-7 furniture is ACTUALLY IN THE FRAME.
 *
 * WHY THIS IS HERE AND NOT IN verify-world.mjs
 * --------------------------------------------
 * Every pass-7 world check reads a COUNT: `pool.used`, "a machine has one liner",
 * "nothing stands in a carriageway". A count cannot see the camera. So the pass
 * was able to satisfy all six of its own checks while placing every family
 * outside the frustum of all fourteen views, and the gallery was a street with
 * nothing on the kerb. This is the only place in the repository that can answer
 * the question honestly, because it is the only place holding the real
 * `PerspectiveCamera` after the real steps have run.
 *
 * HOW A PIECE IS MEASURED
 * ----------------------
 * The instance matrix's translation is the piece's origin, and its three basis
 * columns give the world-space half-extents. Those make a bounding SPHERE — a
 * box's half-diagonal — which is projected through the camera and turned back
 * into a pixel radius. Three properties of that choice are load-bearing:
 *
 *   - The radius comes from the COLUMN NORMS, not from single matrix ELEMENTS.
 *     `place` composes a yaw, so element 0 of a yawed instance is
 *     `scaleX * cos(yaw)` and element 8 is `scaleX * sin(yaw)`: at 60 degrees
 *     element 0 reads 0.055 for a true 0.11, and the scale is wrong by a factor
 *     of two. The NORM of that column is `scaleX` at every yaw, because rotation
 *     preserves length. Measured, not asserted — and note the direction of the
 *     damage: it is a cone, not a box, that collapses under a wrong scale, and
 *     `bollards` is the one pass-7 family built from a cylinder and the one
 *     placed with a yaw.
 *   - The extent is the GEOMETRY's own, per pool, so a torus wheel and a plane
 *     poster are measured by their real extents rather than by the box the pool
 *     was created with. `posters` is a `PlaneGeometry(POSTER_U, 1)`: measuring
 *     it as a cube would inflate its screen size by 1.7 and let a poster 60 m
 *     away pass a gate meant to keep furniture close enough to read.
 *   - A sphere rather than the box's eight corners, because the corners of a
 *     piece straddling the near plane project to nonsense (some behind the eye,
 *     `w < 0`, and the division flips), and a piece CLIPPED by the near plane is
 *     a piece the photographer has a real problem with.
 *
 * AND WHY IT IS NOT A RAYCAST
 * ---------------------------
 * A raycast from the lens to each piece would prove the piece is unoccluded,
 * which is stronger than "it is in frame". It is also the wrong gate here: a
 * dumpster 30 m down an avenue is *in the photograph* whether or not a lamp post
 * is 2 cm of its way, and demanding zero occlusion across 14 views x ~700
 * instances would fail on a hair. The floor's job is to exclude furniture that
 * is not in the picture at all.
 *
 * The result is recorded, not merely asserted: `tools/capture.mjs` writes it into
 * `benchmark/captures.json` and `verify.mjs` reads it back, so a reviewer sees
 * the counts instead of trusting a pass/fail.
 */
function sightline() {
  const street = game.streetView
  const camera = game.camera
  // The drawing buffer's own pixel height, which is what the focal length below
  // has to be in: a pixel radius is only a pixel radius against the frame the PNG
  // was cut to. `devicePixelRatio` is 1 here (the harness pins the viewport), so
  // this equals the viewport height, and reading it rather than restating the
  // number is what keeps a future DPR-aware capture honest instead of measuring
  // a frame twice the size of the one on disk.
  const canvas = game.canvas ?? game.renderer?.domElement
  const height = canvas?.height || view.viewport.height
  // `fov` is the VERTICAL field in degrees, so the focal length in pixels is
  // half-height over its tangent — recovered from the camera rather than restated
  // as `height / 2 / tan(36)`, which is the same number right up until someone
  // changes the FOV and the gate silently measures a different lens than the one
  // taking the picture.
  const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360)
  // `Vector4` because the projection needs w (see the note in the loop below).
  // `position` is gone for the same reason: with a 4-wide vector the instance
  // origin is written straight into `viewPoint`, and a second vector holding the
  // same three numbers is a third place for the two to disagree.
  const viewPoint = new THREE.Vector4()
  const clip = new THREE.Vector4()
  const families = {}
  let onScreen = 0
  let legible = 0
  let nearest = Infinity

  for (const family of FURNITURE_FAMILIES) {
    let pieces = 0
    let read = 0
    let biggest = 0
    for (const name of family.pools) {
      const pool = street.pools[name]
      if (!pool) continue
      const array = pool.mesh.instanceMatrix.array
      // the geometry's own extent, in its own units, so a plane is not a cube
      const geometry = pool.mesh.geometry
      if (!geometry.boundingSphere) geometry.computeBoundingSphere()
      const unit = (geometry.boundingSphere?.radius ?? 0.87) * 0.5
      for (let i = 0; i < pool.used; i += 1) {
        const at = (k) => array[i * 16 + k]
        // COLUMN NORMS, not single elements: rotation preserves length, so the
        // norm of a basis column is the scale at every yaw. See the note above.
        const sx = Math.hypot(at(0), at(1), at(2))
        const sy = Math.hypot(at(4), at(5), at(6))
        const sz = Math.hypot(at(8), at(9), at(10))
        const radius = unit * Math.max(sx, sy, sz)
        // The view matrix FIRST, and the depth test on its output. In view space
        // `z` is negative in front of the lens, so `depth = -z` is the distance a
        // reader would measure with a tape, and rejecting anything at or behind
        // `camera.near` is what stops the OTHER TWO WRAPPED COPIES of the world
        // from padding the count. Every pool sets `frustumCulled = false`, so
        // nothing else in the build does this for us — a 448 m window holds three
        // copies of every piece in it, and all but a few hundred of those are
        // behind the camera at any moment.
        viewPoint.set(at(12), at(13), at(14), 1).applyMatrix4(camera.matrixWorldInverse)
        const depth = -viewPoint.z
        if (!(depth > camera.near) || depth > camera.far) continue
        clip.copy(viewPoint).applyMatrix4(camera.projectionMatrix)
        // `Vector4` and not `Vector3`, and this line is the whole reason the probe
        // works at all. `Vector3.applyMatrix4` divides by w for you, throws w away,
        // and leaves a point 5 m in front of the lens indistinguishable from one
        // behind it — so a `w > 0` guard written against it rejects the ENTIRE
        // frustum and reports an empty frame.
        //
        // The first version of this probe did exactly that: correct reasoning,
        // `Vector3`, and zero furniture in all fourteen views — which reads
        // precisely like the defect it was built to find. It was found by
        // checking the probe against a camera pointed at a known point, and it is
        // written down here because the failure is so attractive: a gate that can
        // only report "nothing there" agrees with any bug that puts nothing there,
        // including its own.
        const w = clip.w
        if (!(w > 0)) continue
        const ndcX = clip.x / w
        const ndcY = clip.y / w
        // Off-frame on BOTH axes is out. On one axis it is not: a dumpster filling
        // the right third of the frame is in the photograph, and rejecting it for
        // crossing the edge would make this a gate on the crop, not the world.
        if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) continue
        // A sphere of world radius r at depth d covers r * focal / d pixels of
        // radius — an exact identity for a sphere on the optical axis and the
        // right order of magnitude off it. It needs no second look at the NDC
        // position: a pixel size is a property of the distance and the lens, not
        // of where on the frame the piece landed.
        const pixels = (radius * focal) / depth
        if (pixels > biggest) biggest = pixels
        if (depth < nearest) nearest = depth
        pieces += 1
        if (pixels >= FURNITURE_MIN_LEGIBLE_PX) read += 1
      }
    }
    families[family.kind] = { pieces, legible: read, maxPx: Number(biggest.toFixed(2)) }
    onScreen += pieces
    legible += read
  }
  const kinds = Object.values(families).filter((entry) => entry.legible > 0).length
  return {
    pools: FURNITURE_POOLS.length,
    onScreen,
    legible,
    kinds,
    nearest: Number.isFinite(nearest) ? Number(nearest.toFixed(2)) : null,
    byKind: families,
  }
}

/**
 * run — take one view, and report what the world looked like when it finished.
 *
 * The report goes back to the harness rather than to a log file, because the one
 * thing a reviewer needs next to a PNG is the proof that the state it shows is
 * the state it claims: which phase, which creature state, how much awareness, how
 * far the figure stood, and how many sigils are lit. Those numbers are read out of
 * the live world and not out of the script, so a script that quietly stopped
 * working cannot be dressed up by its own intentions.
 *
 * `simFrozen` is the same idea applied to time. §16.5.13 calls the pause view
 * "§14.3's card over a completely frozen simulation", and a card is not a
 * measurement: the only honest way to photograph a freeze is to sample the
 * world's own clock on either side of the frames that were rendered and report
 * whether it moved. Every other view must report `false` — a live world that
 * claims to be frozen is a broken world, and `verify.mjs` fails on it.
 */
async function run(id) {
  const view = viewById(id)
  if (!view) throw new Error(`no such capture view: ${id}`)
  if (!game) throw new Error('the capture page never built a world')
  // a page whose loop a previous run left held is a page whose world is stopped.
  // Put it back before a single step is taken, so no frame of this run is drawn
  // from a stopped world. `run` holds it again at the end, for every view.
  releaseLoop()
  const started = performance.now()
  for (const step of view.steps) await applyStep(step)
  // the clock either side of the frames the PNG is taken from
  const before = game.animTime
  await frames(1)
  // Pass 15. THE HELD LOOP, and it starts HERE for EVERY view rather than only for the
  // probe's.
  //
  // `frames(1)` resolves inside the very frame whose `_animate` drew the picture, and
  // at that moment `game.rafId` names the NEXT one — so cancelling it stops the world
  // on the frame the snapshot below is about to describe.
  //
  // For a probe frame this is load-bearing, because its baseline is a subtraction
  // against a second shutter taken a second of wall clock later. For a GALLERY frame it
  // is load-bearing too, and it was not until this pass measured it: the shutter is
  // about a second of wall clock at this renderer's rate, so a loop that is still
  // running lets the world take a clamped 0.05 s frame — or two — between the frame
  // that was drawn and the picture that was read. §16.5's `banish` is the case in
  // point, and the pass named the wrong subject in it: this comment used to say its
  // "eye is 21 luma above the finder's floor of 150" and that "the committed
  // `banish.png` measured 171 and the next run of the same steps found nothing at
  // all". There is no eye in that frame. REVIEW 15 measured it: §16.5.9 stages the
  // banish at 1.9 m, so the figure's head projects to y = -446 on a 720 px frame and
  // its face is not in the picture. The 171 was a lit WINDOW behind the creature —
  // a 13 x 10 block at 185-188 with the creature taken out of the way — of which the
  // creature's body then covered all but two columns, and a 0.05 s difference in
  // where the body stands changes what those two columns read.
  //
  // The hold is right and the reason is stronger than the one this comment gave: what
  // it fixed was not a creature's eye flickering but a gallery frame whose answer to
  // "is there a creature in this picture" depended on when the shutter was pressed.
  // A gallery whose creature frames are a coin flip is not a gallery, and §6.5's
  // contract is that a set of steps is worth the same picture twice.
  holdLoop()
  shutterTime = game.animTime
  const state = store.get()
  const snapshot = {
    id,
    label: view.label,
    viewport: { ...view.viewport },
    steps: view.steps.length,
    ms: Math.round(performance.now() - started),
    phase: state.phase ?? null,
    paused: state.paused === true,
    simFrozen: game.animTime === before,
    // pass 15. The clock of the last frame drawn, which is the clock this frame's PNG
    // was taken at — the loop is held from here to the shutter — and the clock a
    // probe frame's baseline is measured against.
    shutterTime: round(shutterTime),
    loop: state.loop ?? null,
    portals: { ...(state.portals ?? {}) },
    finale: game.state.finale === true,
    hammerHeld: game.state.hammerHeld === true,
    hold: Number(game._hold.toFixed(3)),
    creature: game.creature.state,
    awareness: Number((game.creatureAwareness ?? 0).toFixed(3)),
    // pass 15. The three numbers a per-state light measurement cannot be read
    // without: the pose the frame was drawn with, where the head landed in
    // pixels (so the eye finder can be checked against the subject rather than
    // trusted), and the scale a metre has at that depth (so the shimmer's
    // curtains can be located in the picture instead of in a comment).
    pose: poseReport(),
    where: where(view.viewport),
    dusk: game.state.dusk,
    fade: Number(game.fade.toFixed(3)),
    banished: game.state.banishCount,
    // pass 7's gate. Measured here because this is the only place holding the
    // camera the PNG is taken through, after the steps that aimed it.
    furniture: sightline(),
  }
  window.__captureDone = snapshot
  return snapshot
}

window.__captureRun = run

/**
 * __captureBaseline — the SAME world with the figure taken out of it, one frame
 * later, and nothing else changed. ITERATION 2, PASS 15.
 *
 * WHY NOT A SECOND VIEW
 * ---------------------
 * The first version of the probe took its baseline as its own capture view: the
 * `stalk` step list with the `creature` step removed, run as a second page load.
 * Two runs of the same steps are the same world only to the order of a frame, and
 * this measurement is worth one level of luma. Between them: `flickerAt`'s hashed
 * lamp dropouts tick on `animTime` and the rows' waits are not the control's wait,
 * the sky's ash drifts, the two runs' `animTime` differ by the sampling delay, and
 * the render itself carries about 1.3 levels of per-pixel noise. A one-level
 * measurement cannot be a subtraction of two one-second runs.
 *
 * So the baseline is taken in the same page, at the same clock, by removing the
 * figure and rendering one more frame — which is also a STRICTLY better control
 * than a separately written view was, because it is the same picture with one thing
 * taken out of it rather than a second picture of a world that resembles it.
 *
 * THE FOUR THINGS THAT HAD TO BE TRUE
 * ------------------------------------
 *  1. **The figure has to actually leave.** `creatureStep` is the state machine
 *     that owns the removal, so the state is set and the world is stepped, not
 *     bypassed: `dormant` is a state the machine reaches on its own, and
 *     `creaturePose` reads it as `present: false`, which is what hides the rig, the
 *     trail, the dust and the column in one line.
 *  2. **The lamps have to go back.** `_writeLampDread` is handed a drawn position
 *     for any figure that exists, whatever its state, so a merely-dormant creature
 *     would leave the pool drodded and the pulse applied — and the pool is most of
 *     the frame. Passing `null` is the world's own "nothing near any lamp" path,
 *     which is what §9.3 and §10.4 use and what a world with no creature in it
 *     looks like.
 *  3. **The clock must not move.** §6.5's contract is the whole reason a capture
 *     set is reproducible, and the render loop is the one thing here that can move
 *     the world between two shutters. It is ALREADY held: `run` holds it the
 *     moment the creature's last frame is drawn, so the world is standing on the
 *     frame this baseline is a control for, and nothing re-arms it in between.
 *  4. **And the drawing buffer has to survive to the shutter.** One frame is
 *     stepped with `dt` 0, the frame is drawn, and then ONE COMPOSITOR frame is
 *     waited for — a bare `requestAnimationFrame`, with no `_animate` behind it,
 *     because what the shutter needs is for the browser to commit the canvas it
 *     was just handed, not for the world to have another go at it.
 *
 * WHY 3 IS A FIX AND NOT THE ORIGINAL SENTENCE
 * ---------------------------------------------
 * The first version held the loop here, at the top of this call, and then put it
 * BACK before the shutter — one `requestAnimationFrame`, one wait. The frame that
 * came back was worth 0.05 s of world time every single run, and not by accident:
 * `world.js` clamps its delta to 0.05 s, and the delta it was handed was the
 * second the software renderer had just spent drawing the frame underneath it, so
 * the clamp was what the control was made of. The measured drift was 0.05 s on
 * every row, against a 0.02 s ceiling, which is the gate this file's own pass
 * wrote catching its own harness. Holding the loop across BOTH shutters is the
 * same fix at the other end: the picture the baseline is compared against is the
 * one the creature was drawn in, and the loop is off for the whole of it.
 *
 * @returns the clock either side, what is still on screen, and the lamp record
 */
window.__captureBaseline = async () => {
  if (!game) throw new Error('the capture page never built a world')
  if (shutterTime === 0) {
    throw new Error('no frame has been shuttered from this page, so there is no clock for a baseline to share')
  }
  if (!loopHeld) {
    throw new Error('the render loop is not held, so the clock moves under the shutter and this is a second world')
  }
  const before = game.animTime
  // 1. the figure leaves, by the state machine's own door
  game.creature.state = 'dormant'
  game.creature.staggerSeconds = 0
  game.dismissing = false
  game.dismissElapsed = 0
  game.spotElapsed = null
  game.update(0)
  // 2. ...and the lamps go back to what a world with nothing in it looks like
  game._writeLampDread(null)
  game.renderer.render(game.scene, game.camera)
  // 3. one COMPOSITOR frame, and no world frame behind it. This is the whole
  // difference from the version that re-armed the loop here.
  await frame()
  return {
    animTime: round(game.animTime),
    // the clock of the frame this baseline is a control FOR, not the clock of the
    // moment the control was taken — those are the same number now, and `drift`
    // is the proof rather than the intention.
    frameTime: round(shutterTime),
    drift: round(game.animTime - shutterTime),
    // the movement inside this call on its own, reported because "the clock is
    // held" is a claim and a claim with no number is a comment.
    held: round(game.animTime - before),
    loopHeld,
    creature: game.creature.state,
    presented: game.creatureView.root.visible === true,
    shimmer: game.creatureView.haze.visible === true,
    lamp: { lamp: game.lampDread.lamp, level: round(game.lampDread.level), pulse: round(game.lampDread.pulse) },
  }
}
