#!/usr/bin/env node
/**
 * verify-world.mjs — headless INTEGRATION smoke test for the Three.js world.
 *
 * verify.mjs proves the pure modules; this file drives the real `BellLoopGame`
 * state machine (maze load, walls rising, bell reset, candle interaction, door
 * blocker, win, restart) with a stubbed DOM + a stubbed renderer, because a
 * script cannot click or look at the canvas.
 *
 * Run: node verify-world.mjs   (exit code 0 = the whole loop works)
 */
import assert from 'node:assert/strict'

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
    bellToll: record('bellToll'),
    bellSequence: record('bellSequence'),
    footstep: record('footstep'),
    candleWhoosh: record('candleWhoosh'),
    doorCreak: record('doorCreak'),
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

check('BEGIN starts the loop, rings the bell and raises the walls', () => {
  game.start()
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().timeLeft, LOOP_SECONDS)
  assert.ok(audio.calls.includes('bellToll'), 'the first toll should ring on BEGIN')
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
  assert.ok(audio.calls.filter((name) => name === 'footstep').length > 0, 'no footsteps emitted')
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
  assert.ok(audio.calls.includes('candleWhoosh'))
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
  assert.ok(audio.calls.includes('bellSequence'))
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
  assert.ok(!audio.calls.includes('doorCreak'), 'no creak before the door opens')

  store.set({ timeLeft: 0.2 })
  run(game, RESET_TIMELINE.total + 0.8)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().loop, 3)
  assert.equal(store.get().doorOpen, true, 'the door stands open from loop 3')
  assert.equal(game.doorOpen, true)
  assert.ok(audio.calls.includes('doorCreak'), 'the door should creak open')
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
