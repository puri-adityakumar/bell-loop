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
import { LongQuietGame } from '../src/game/world.js'
import { createStartStore, PHASE } from '../src/game/store.js'
import { hudSnapshot } from '../src/ui/hud.js'
import * as beast from '../src/game/creature.js'
import * as hood from '../src/game/neighborhood.js'
import * as rules from '../src/game/rules.js'
import { captureView, STREET_NODE } from '../src/game/capture.js'
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
 */
function placeCreature({ state, metres, bearing = 0 }) {
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
  }
  game.dismissing = false
  game.dismissElapsed = 0
  game.reemergeElapsed = beast.FADE_SECONDS.reemerge + 0.3
  game.banishElapsed = 0
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
  const view = captureView(id)
  if (!view) throw new Error(`no such capture view: ${id}`)
  if (!game) throw new Error('the capture page never built a world')
  const started = performance.now()
  for (const step of view.steps) await applyStep(step)
  // the clock either side of the frames the PNG is taken from
  const before = game.animTime
  await frames(1)
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
    loop: state.loop ?? null,
    portals: { ...(state.portals ?? {}) },
    finale: game.state.finale === true,
    hammerHeld: game.state.hammerHeld === true,
    hold: Number(game._hold.toFixed(3)),
    creature: game.creature.state,
    awareness: Number((game.creatureAwareness ?? 0).toFixed(3)),
    dusk: game.state.dusk,
    fade: Number(game.fade.toFixed(3)),
    banished: game.state.banishCount,
  }
  window.__captureDone = snapshot
  return snapshot
}

window.__captureRun = run
