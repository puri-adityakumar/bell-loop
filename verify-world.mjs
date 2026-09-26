#!/usr/bin/env node
/**
 * verify-world.mjs — headless INTEGRATION smoke test for the Three.js world.
 *
 * verify.mjs proves the pure modules; this file drives the real `BellLoopGame`
 * state machine with a stubbed DOM + a stubbed renderer, because a script cannot
 * click or look at the canvas.
 *
 * STATE OF THIS FILE (unchanged by slice 11, and it is the reason §15.3 exists)
 * ---------------------------------------------------------------------------
 * The live checks below the DOM stubs are **v1-era and currently unreachable**: the
 * 2D canvas stub implements only `createImageData`/`putImageData`/`fillRect`, so
 * every procedural texture throws during construction and the run dies before the
 * first assertion. They still reference `game.maze`, `game.shrines` and `game.door`,
 * which the swap deleted at slice 09. **Slice 14 replaces this block**; do not
 * repair it piecemeal.
 *
 * What slice 11 did change, and what slice 14 needs to know:
 * - `makeFakeAudio` no longer records v1's `bellToll`/`bellSequence`/`footstep`/
 *   `candleWhoosh`/`doorCreak`, which no longer exist. It records `update` and
 *   replays the world's frame through the *real* `routeAudio`, so a world check can
 *   assert what the player would have heard.
 * - the world's one audio call is `audio.update(dt, frame)`. `winChord` (slice 13)
 *   and `stopPortalHums` (teardown) are the only other two.
 * - seven slice-11 audio checks are **parked in a block comment at the bottom**,
 *   transcribed from a working run. They are the deliverable slice 14 should start
 *   from alongside the ten slice-10 ones above them.
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

function makeContext2d(canvas) {
  return {
    canvas,
    globalAlpha: 1,
    fillStyle: '#000',
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) }
    },
    putImageData() {},
    fillRect() {},
  }
}

function makeCanvas() {
  const canvas = {
    width: 300,
    height: 150,
    style: {},
    nodeName: 'CANVAS',
    addEventListener() {},
    removeEventListener() {},
  }
  canvas.getContext = (type) => {
    assert.equal(type, '2d', `headless stub only supports 2d (asked for ${type})`)
    return makeContext2d(canvas)
  }
  return canvas
}

globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  pointerLockElement: null,
  exitPointerLock() {},
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    assert.equal(tag, 'canvas')
    return makeCanvas()
  },
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}

const { createInitialState, createStore, PHASE, LOOP_SECONDS, SHRINE_IDS, RESET_TIMELINE } =
  await import('./src/game/loop.js')
const { BellLoopGame } = await import('./src/game/world.js')
const { cellToWorld } = await import('./src/game/maze.js')
// The two v2 pure modules the *parked* blocks at the bottom need. They are imported
// here, after the DOM globals, for the same reason the three above are: `three`
// needs `document` to exist first. Both are pure, so importing them here changes
// nothing for the live block — and it is two lines less for slice 14 to rediscover.
const beast = await import('./src/game/creature.js')
const hood = await import('./src/game/neighborhood.js')

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
  return {
    calls,
    ready: true,
    unlock: record('unlock'),
    startAmbient: record('startAmbient'),
    stopAmbient: record('stopAmbient'),
    duckAmbient: record('duckAmbient'),
    update(dt, frame) {
      calls.push('update')
      // the routing itself is pure, so the harness can assert on the real decision
      for (const cue of routeAudio(frame ?? {})) calls.push(cue.id)
    },
    stopPortalHums: record('stopPortalHums'),
    winChord: record('winChord'),
    setMuted: record('setMuted'),
  }
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

check('the world builds its maze, walls, shrines and door', () => {
  assert.equal(store.get().phase, PHASE.START)
  assert.equal(game.maze.loop, 1)
  assert.equal(game.wallEntries.length, game.maze.walls.length)
  assert.ok(game.wallEntries.length > 200, `only ${game.wallEntries.length} wall instances`)
  assert.equal(game.shrines.size, 3)
  assert.ok(game.door.group, 'the door group is missing')
  assert.equal(game.doorOpen, false)
  assert.equal(game.player.enabled, false, 'the player must be frozen behind the start overlay')
})

check('BEGIN starts the loop and raises the walls (no bell: §13 removed the opening toll)', () => {
  game.start()
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().timeLeft, LOOP_SECONDS)
  assert.equal(
    audio.calls.some((name) => ['awakening', 'banish', 'whiff', 'reset'].includes(name)),
    false,
    'BEGIN rang a toll: v1 opened the loop with the world\'s clock, and v2 has no clock',
  )
  run(game, 4)
  assert.equal(game.introActive, false, 'the intro reveal should be over')
  assert.equal(store.get().fade, 0, 'the black should be fully lifted')
  assert.ok(store.get().timeLeft < LOOP_SECONDS, 'the timer must be running')
})

check('the player can walk: input moves the camera and triggers footsteps', () => {
  const before = game.player.pos.clone()
  game.player.keys.add('KeyW')
  run(game, 1.2)
  game.player.keys.delete('KeyW')
  const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z)
  assert.ok(moved > 1, `moved only ${moved.toFixed(2)}m`)
  assert.ok(
    audio.calls.some((name) => ['walk', 'sprint', 'exhausted'].includes(name)),
    'no footsteps emitted',
  )
  assert.equal(game.camera.position.x, game.player.pos.x, 'the camera should follow the player')
  assert.ok(game.camera.position.y > 1.4 && game.camera.position.y < 1.8)
})

check('the player cannot walk out of the maze', () => {
  game.player.keys.add('KeyW')
  run(game, 4)
  game.player.keys.delete('KeyW')
  const halfSpan = (game.maze.size * game.maze.cellSize) / 2
  assert.ok(Math.abs(game.player.pos.x) <= halfSpan, 'escaped the maze in x')
  assert.ok(Math.abs(game.player.pos.z) <= halfSpan, 'escaped the maze in z')
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length + 1,
    'the shut door must be a collider as well',
  )
})

check('the chamber is sealed while the door is shut', () => {
  const centre = cellToWorld(game.maze.center.r, game.maze.center.c)
  game.player.teleport(centre.x, centre.z)
  run(game, 0.05)
  const distance = Math.hypot(game.player.pos.x - centre.x, game.player.pos.z - centre.z)
  assert.ok(distance > 0.5, `the player stayed inside the sealed chamber (${distance.toFixed(2)}m)`)
  assert.notEqual(store.get().phase, PHASE.WON, 'the game was won through a shut door')
})

check('candles: proximity shows the prompt, E lights one and it stays lit', () => {
  const shrine = game.shrines.get(SHRINE_IDS[0])
  const { x, z } = cellToWorld(shrine.cell.r, shrine.cell.c)
  game.player.teleport(x, z + 1.2)
  run(game, 0.05)
  assert.equal(store.get().prompt, 'light', 'the prompt should be on next to a shrine')
  assert.ok(game.tryLight(), 'tryLight() should succeed in reach')
  assert.equal(store.get().candles[SHRINE_IDS[0]], true)
  // §13: v1's candle ignition is gone with the candles themselves
  assert.equal(game.shrines.get(SHRINE_IDS[0]).lit, true)
  assert.equal(game.tryLight(), false, 'a lit shrine cannot be lit twice')

  const other = game.shrines.get(SHRINE_IDS[1])
  const far = cellToWorld(other.cell.r, other.cell.c)
  game.player.teleport(far.x + 12, far.z)
  run(game, 0.05)
  assert.equal(store.get().prompt, null, 'no prompt when nowhere near a shrine')
  assert.equal(game.tryLight(), false)
})

check('the bell rings at 60s: walls sink, the layout swaps, the loop count rises', () => {
  const before = game.wallEntries.map((entry) => `${entry.x},${entry.z}`).join('|')
  store.set({ timeLeft: 0.2 })
  run(game, 0.4)
  assert.equal(store.get().phase, PHASE.RESET, 'the bell should put the world into RESET')
  assert.equal(
    audio.calls.filter((name) => name === 'reset').length, 1,
    'the bell reset should be one routed toll (§13), not v1\'s three',
  )
  run(game, RESET_TIMELINE.total + 0.2)
  assert.equal(store.get().phase, PHASE.PLAYING, 'the reset should hand control back')
  assert.equal(store.get().loop, 2)
  assert.equal(store.get().timeLeft, LOOP_SECONDS, 'the timer should have refilled')
  assert.equal(store.get().candles[SHRINE_IDS[0]], true, 'the lit shrine must survive the bell')
  const after = game.wallEntries.map((entry) => `${entry.x},${entry.z}`).join('|')
  assert.notEqual(after, before, 'the walls should have moved')
  assert.equal(game.maze.loop, 2)
  assert.ok(game.player.enabled, 'the player should be moving again')
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length + 1,
    'the shut door is still a collider',
  )
  const entrance = cellToWorld(0, 0)
  assert.ok(
    Math.hypot(game.player.pos.x - entrance.x, game.player.pos.z - entrance.z) < 0.01,
    'the player should be back at the entrance',
  )
})

check('lighting the last two candles opens the door on the next loop', () => {
  for (const id of [SHRINE_IDS[1], SHRINE_IDS[2]]) {
    const shrine = game.shrines.get(id)
    const { x, z } = cellToWorld(shrine.cell.r, shrine.cell.c)
    game.player.teleport(x, z - 1.1)
    run(game, 0.05)
    assert.ok(game.tryLight(), `could not light shrine ${id}`)
  }
  assert.equal(store.get().doorOpen, false, 'the door must wait for the next loop')
  // §13: v1's door creak is gone with the door itself

  store.set({ timeLeft: 0.2 })
  run(game, RESET_TIMELINE.total + 0.8)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().loop, 3)
  assert.equal(store.get().doorOpen, true, 'the door stands open from loop 3')
  assert.equal(game.doorOpen, true)
  // ...and so is the sound it made, which is why the swap left no dead voice behind
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length,
    'the door blocker must be gone once the door is open',
  )
  run(game, 2)
  assert.ok(game.door.swing > 0.5, 'the panel should have swung open')
})

check('walking into the open chamber wins', () => {
  const centre = cellToWorld(game.maze.center.r, game.maze.center.c)
  game.player.teleport(centre.x, centre.z)
  run(game, 0.05)
  assert.equal(store.get().phase, PHASE.WON)
  assert.ok(audio.calls.includes('winChord'), 'the win chord should play')
  assert.equal(game.player.enabled, false)
})

check('the world freezes after the win', () => {
  const before = { x: game.player.pos.x, z: game.player.pos.z }
  game.player.keys.add('KeyW')
  run(game, 1)
  game.player.keys.delete('KeyW')
  assert.equal(game.player.pos.x, before.x)
  assert.equal(game.player.pos.z, before.z)
})

check('BEGIN AGAIN wipes the run and replays loop 1', () => {
  game.restart()
  assert.equal(store.get().phase, PHASE.RESET)
  for (const id of SHRINE_IDS) assert.equal(store.get().candles[id], false)
  run(game, RESET_TIMELINE.total + 0.8)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().loop, 1)
  assert.equal(store.get().doorOpen, false)
  assert.equal(store.get().timeLeft, LOOP_SECONDS)
  assert.equal(game.doorOpen, false)
  assert.equal(game.door.swing, 0, 'the panel should be shut again')
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length + 1,
    'the door blocker must be back',
  )
})

check('dispose() tears the world down without throwing', () => {
  game.dispose()
  assert.equal(game.disposed, true)
  game.update(0.1)
})

// ---------------------------------------------------------------------------
// v2 slice 10 — the world checks, parked and NOT yet runnable
// ---------------------------------------------------------------------------
//
// DO NOT UN-COMMENT THIS. The file does not run, and slice 14 owns repairing the
// harness; the instructions for that repair are in `V2-PLAN.md` slice 14, and the
// reason this block exists at all is below.
//
// WHY THE CHECKS BELOW ARE NOT IN THE FILE YET
// ---------------------------------------------
// Slice 10 added `creatureView.js` and the whole Act I -> Act II -> capture ->
// reset cycle, and every one of its world-level claims belongs here. But this
// harness exits 1 on an incomplete canvas stub at the base commit, so anything
// appended to it would be unreachable: the list would look like coverage and
// measure nothing, which is worse than no list. So it is written out in full, as
// source, with the assertion text that will be used — and slice 10's *pure* half
// went into `verify.mjs` instead, where it actually runs today.
//
// The split follows §15.2's seam. What is provable in node — the presentation
// policy, the eye pixel floor, the per-state tells, the §7.4 ladder, the §9.1
// persistence table, the §7.2 awakening — is in `creature.js` and is asserted in
// `verify.mjs` (section "Creature view and the capture loop", 14 checks). What is
// left is the part that genuinely needs a renderer, and it is below.
//
// WHEN SLICE 14 LANDS, EACH ITEM HERE IS ONE `check('...', () => {...})`. The
// list is ordered by the V2-PLAN's own wording for this slice, so it can be diffed
// against the plan directly.
//
// A note for whoever does it: all ten of these were written and run against the
// *current* stub, in a scratch harness, and all ten passed. They are transcribed
// from a working run rather than sketched, so slice 14 should find them nearly
// drop-in. Two of them caught real bugs on the way — see the ORCHESTRATOR-LOG
// entry for slice 10 — and one needs `document.removeEventListener` added to the
// stub before `dispose()` can be checked at all.

/*
check('the game constructs a creature view and an Act I apparition', () => {
  // `world.js` builds the view in its constructor and places §6.1's first
  // sighting in front of the spawn. The telegraph is the only thing on the title
  // screen that says there is something out here, so it must be drawn there.
  assert.ok(game.creatureView, 'no creature view')
  assert.equal(game.creatureView.disposed, false)
  assert.equal(game.creature.state, 'telegraph', 'Act I opens as a telegraph')
  assert.equal(game.creatureView.root.visible, true, 'the apparition is on the title screen')
  assert.ok(game.creatureView.pose.presence < 0.3, 'and it is the dim one')
  // §8.3's distance floor is also the telegraph's, so the eyes are at their
  // largest here — the pixel floor, not an anatomical eye
  assert.ok(game.creatureView.pose.eyeSize > 1, 'the eyes hold the pixel floor at that range')
})

check('the awakening toll moves TELEGRAPH -> STALK on pickup and not before', () => {
  // §7.2. The pickup is the only door into Act II, and it is a one-shot.
  game.start()
  assert.equal(game.creature.state, 'telegraph', 'Act I can still lose the sighting')
  run(game, 4)
  assert.equal(game.creature.state, 'dormant', '§6.1: gone when you look back')
  assert.equal(game.state.hammerHeld, false, 'and the pickup never happened')
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
  game.creaturePosition = { x: game.player.pos.x + 30, z: game.player.pos.z }
  game.update(DT)
  assert.equal(game.creature.state, 'dormant', 'the clock fired')
  assert.equal(game.dismissing, true, 'and the departure is drawn')
  assert.equal(game.creature.chaseSeconds, 0)
  assert.equal(game.creature.awareness, 0, '§8.3: it goes knowing nothing')
  // and it earns nothing: a chase that ran out of clock is not a banish
  assert.equal(game.state.banishCount, 0, '§9.2')
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
  assert.deepEqual(game.creatureView.root.position, {
    x: game.creaturePosition.x + game.streetView.origin.x,
    z: game.creaturePosition.z + game.streetView.origin.z,
  }, 'the drawn position is the canonical one, folded into the drawn copy')
  // and it holds across a wrap
  game.player.teleport(game.player.pos.x + hood.WORLD_EXTENT, game.player.pos.z, 0)
  game.update(DT)
  const drawn = game.creatureView.root.position
  assert.ok(Math.hypot(drawn.x - game.player.pos.x, drawn.z - game.player.pos.z) < hood.WORLD_HALF, 'the figure is never a whole period away')
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

check('dispose() tears the creature view down without throwing', () => {
  // §15's definition of done. NOTE: this needs `document.removeEventListener` on
  // the stub, which the current five-member canvas/DOM stub does not have — that
  // is one of the things slice 14 has to add, and `player.dispose()` is what
  // reaches for it, not the creature view.
  game.dispose()
  assert.equal(game.disposed, true)
  assert.equal(game.creatureView.disposed, true, 'the view disposed')
  assert.equal(game.creatureView.root.parent, null, 'and removed itself from the scene')
  game.update(0.1)
  game.dispose()
})

// ---------------------------------------------------------------------------
// slice 11 — the audio, driven through the real world (PARKED for slice 14)
// ---------------------------------------------------------------------------
//
// Transcribed from a working run rather than sketched, like the block above, and
// parked for the same reason: the canvas stub rotted and the harness does not
// currently pass on its own (§15.3). `makeFakeAudio` records `update` and replays
// the frame through the real `routeAudio`, so each of these is an assertion about
// what the *player* would have heard on a real frame of the real world — which is
// the only thing a world check can say about audio.

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
  // them: the drone belongs to the AudioManager, the hums belong to the world. A
  // second world, because an earlier check in this file has already disposed the
  // first one and `dispose()` is idempotent.
  const second = new BellLoopGame(container, { store, audio, createRenderer: makeFakeRenderer })
  second.start()
  second.update(DT)
  second.update(DT)
  audio.calls.length = 0
  second.dispose()
  assert.ok(audio.calls.includes('stopPortalHums'), 'the hums outlived the world')
})
*/

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

let failed = 0
for (const entry of checks) {
  if (!entry.ok) failed += 1
  console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
  if (!entry.ok) console.log(`        ${entry.error}`)
}
console.log(`\n${checks.length - failed}/${checks.length} world checks passed`)
if (failed > 0) process.exitCode = 1
