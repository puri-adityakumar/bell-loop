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
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    beginPath() {},
    arc() {},
    ellipse() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) }
    },
    createRadialGradient() {
      return { addColorStop() {} }
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
    lockMode: 'success',
    requestPointerLock(options) {
      if (this.lockMode === 'manual') return undefined
      if (this.lockMode === 'error-once' && options) {
        globalThis.document.dispatchEvent('pointerlockerror')
        return undefined
      }
      if (this.lockMode === 'error') {
        globalThis.document.dispatchEvent('pointerlockerror')
        return Promise.reject(new Error('pointer lock unavailable'))
      }
      globalThis.document.pointerLockElement = this
      globalThis.document.dispatchEvent('pointerlockchange')
      return undefined
    },
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
const documentListeners = new Map()
globalThis.document = {
  hidden: false,
  pointerLockElement: null,
  exitPointerLock() {
    this.pointerLockElement = null
  },
  addEventListener(type, listener) {
    const listeners = documentListeners.get(type) ?? new Set()
    listeners.add(listener)
    documentListeners.set(type, listeners)
  },
  removeEventListener(type, listener) {
    documentListeners.get(type)?.delete(listener)
  },
  getListenerCount(type) {
    return documentListeners.get(type)?.size ?? 0
  },
  dispatchEvent(type) {
    for (const listener of documentListeners.get(type) ?? []) listener({ type })
  },
  createElement(tag) {
    assert.equal(tag, 'canvas')
    return makeCanvas()
  },
}
let animationFrameCallback = null
globalThis.requestAnimationFrame = (callback) => {
  animationFrameCallback = callback
  return 1
}
globalThis.cancelAnimationFrame = () => {}

const { createInitialState, createStore, PHASE, LOOP_SECONDS, RESET_TIMELINE, RESET_SWAP_AT } =
  await import('./src/game/loop.js')
const { BellLoopGame } = await import('./src/game/world.js')
const { SHRINE_IDS, cellToWorld } = await import('./src/game/maze.js')

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
    dispose: record('dispose'),
    silence: record('silence'),
    suspend: record('suspend'),
    resume: record('resume'),
    duckAmbient: record('duckAmbient'),
    setTension: record('setTension'),
    setListener: record('setListener'),
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
  appendChild(canvas) {
    canvas.parentNode = this
  },
  removeChild(canvas) {
    if (canvas.parentNode === this) canvas.parentNode = null
  },
}

const DT = 1 / 60

/** Advance the simulation by `seconds` of game time. */
function run(game, seconds) {
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) game.update(DT)
}

function placeOutsideChamber(game, distance = 2.4) {
  const centre = cellToWorld(game.maze.center.r, game.maze.center.c)
  const direction = {
    N: { x: 0, z: -1 },
    E: { x: 1, z: 0 },
    S: { x: 0, z: 1 },
    W: { x: -1, z: 0 },
  }[game.maze.centerApproach]
  game.player.teleport(
    centre.x + direction.x * distance,
    centre.z + direction.z * distance,
    Math.atan2(direction.x, direction.z),
  )
  return { centre, direction }
}

function walkTowardChamber(game, seconds) {
  game.player.keys.add('KeyW')
  run(game, seconds)
  game.player.keys.delete('KeyW')
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
  assert.equal(game.wallMesh.isInstancedMesh, true)
  assert.equal(game.wallMesh.count, game.wallEntries.length)
  assert.ok(game.wallEntries.length > 200, `only ${game.wallEntries.length} wall instances`)
  assert.equal(game.shrines.size, 3)
  assert.equal(game.scene.fog.density, 0.1)
  assert.equal(game.brickTexture.repeat.x, 2.5)
  assert.equal(game.brickTexture.repeat.y, 2)
  assert.equal([...game.shrines.values()].every((shrine) => shrine.baseIntensity === 8), true)
  assert.ok(game.shrines.get(SHRINE_IDS[0]).embers.material.map)
  assert.equal(game.debrisCapacity, 12)
  assert.ok(game.debris, 'the route debris field is missing')
  assert.ok(game.boatShadow, 'the boat contact shadow is missing')
  assert.equal(game.boatMark.material.map, game.handprintTexture)
  assert.equal(game.beamX.isInstancedMesh, true)
  assert.equal(game.beamZ.isInstancedMesh, true)
  assert.equal(game.beamX.count, 5)
  assert.equal(game.beamZ.count, 5)
  assert.ok(game.door.group, 'the door group is missing')
  assert.equal(game.door.panelL.position.x, game.door.panelWidth / 2)
  assert.equal(game.door.panelR.position.x, -game.door.panelWidth / 2)
  assert.equal(game.door.backingL.position.y, 1.17)
  assert.equal(game.door.backingR.position.y, 1.17)
  assert.equal(game.doorOpen, false)
  assert.equal(game.spawnLight.position.y, 0.9)
  assert.equal(game.flashlight.decay, 1.2)
  assert.equal(game.flashlightFill.distance, 4.2)
  assert.equal(game.door.doorLight.visible, false)
  assert.equal(game.door.beyond.material.type, 'MeshStandardMaterial')
  assert.equal(game.door.leakLight.visible, false)
  assert.equal(game.door.hintLight.visible, true)
  assert.equal(game.player.enabled, false, 'the player must be frozen behind the start overlay')
  assert.equal(document.getListenerCount('visibilitychange'), 2)
  assert.equal(document.getListenerCount('pointerlockerror'), 1)
})

check('title drift remains visible after camera pose application', () => {
  const before = game.camera.position.clone()
  game.animTime = 2
  game._updateStartDrift()
  assert.ok(game.camera.position.distanceTo(before) > 0.05)
})

check('BEGIN starts the loop, rings the bell and raises the walls', () => {
  game.start()
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().timeLeft, LOOP_SECONDS)
  assert.ok(audio.calls.includes('bellToll'), 'the first toll should ring on BEGIN')
  run(game, 4)
  assert.ok(audio.calls.includes('setListener'), 'the audio listener should follow the camera')
  assert.equal(game.introActive, false, 'the intro reveal should be over')
  assert.equal(store.get().fade, 0, 'the black should be fully lifted')
  assert.ok(store.get().timeLeft < LOOP_SECONDS, 'the timer must be running')
})

check('the animation frame advances Timer and visibility prevents catch-up', () => {
  const before = game.timeLeft
  assert.equal(typeof animationFrameCallback, 'function')
  animationFrameCallback(game.timer._startTime + 16)
  assert.ok(game.timeLeft < before)
  assert.ok(game.timer.getDelta() > 0 && game.timer.getDelta() < 0.05)

  document.hidden = true
  animationFrameCallback(game.timer._startTime + 1000)
  assert.equal(game.timer.getDelta(), 0)

  document.hidden = false
  document.dispatchEvent('visibilitychange')
  animationFrameCallback(performance.now())
  assert.ok(game.timer.getDelta() < 0.05)
})

check('reduced motion suppresses camera shake and head motion', () => {
  const original = game.reducedMotion
  game.reducedMotion = true
  game.player.reducedMotion = true
  game.addShake(0.1)
  game.update(DT)
  assert.equal(game.shake, 0)
  assert.equal(game.camera.rotation.z, 0)
  game.reducedMotion = original
  game.player.reducedMotion = original
})

check('losing pointer lock pauses the loop and resume restores control', () => {
  assert.equal(game.player.locked, true)
  game.player.keys.add('KeyW')
  game.player.vel.set(1, 1)
  game.player.stepPulse = 1

  document.pointerLockElement = null
  document.dispatchEvent('pointerlockchange')
  assert.equal(store.get().phase, PHASE.PAUSED)
  assert.equal(game.player.enabled, false)
  assert.equal(game.player.vel.x, 0)
  assert.equal(game.player.vel.y, 0)
  assert.equal(game.player.stepPulse, 0)
  assert.equal(game.canvas.tabIndex, -1)
  assert.ok(audio.calls.includes('suspend'))
  const timeBeforePause = game.timeLeft
  const animationBeforePause = game.animTime
  game.player.keys.add('KeyW')
  run(game, 1)
  assert.equal(game.timeLeft, timeBeforePause)
  assert.equal(game.animTime, animationBeforePause)

  game.canvas.lockMode = 'manual'
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PAUSED)
  assert.equal(game.player.enabled, false)
  document.pointerLockElement = game.canvas
  document.dispatchEvent('pointerlockchange')
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.player.enabled, true)
  assert.equal(game.canvas.tabIndex, 0)
  assert.equal(game.player.keys.size, 0)
  assert.ok(audio.calls.includes('resume'))

  document.hidden = true
  document.dispatchEvent('visibilitychange')
  assert.equal(store.get().phase, PHASE.PAUSED)
  document.hidden = false
  document.dispatchEvent('visibilitychange')
  assert.equal(store.get().phase, PHASE.PAUSED)
  game.canvas.lockMode = 'success'
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PLAYING)

  document.pointerLockElement = null
  document.dispatchEvent('pointerlockchange')
  game.canvas.lockMode = 'error-once'
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.player.locked, true)

  document.pointerLockElement = null
  document.dispatchEvent('pointerlockchange')
  game.canvas.lockMode = 'error'
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.player.enabled, true)
})

check('pausing releases pointer lock and resume restores it', () => {
  game.canvas.lockMode = 'manual'
  document.pointerLockElement = game.canvas
  game.player.locked = true
  game._pause('manual')
  assert.equal(store.get().phase, PHASE.PAUSED)
  assert.equal(game.player.locked, false)
  assert.equal(document.pointerLockElement, null)
  assert.equal(game.resume(), true)
  document.pointerLockElement = game.canvas
  document.dispatchEvent('pointerlockchange')
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(game.player.locked, true)
})

check('resume does not wait forever on an inert scene', () => {
  const originalClosest = game.canvas.closest
  const originalLockMode = game.canvas.lockMode
  game.canvas.closest = () => ({ inert: true, hasAttribute: () => true })
  game.canvas.lockMode = 'success'
  game.store.set({ phase: PHASE.PAUSED })
  game.resumePending = false
  game.resumeRequestId = null
  if (game.resumeFallbackTimer) clearTimeout(game.resumeFallbackTimer)
  game.resumeFallbackTimer = null
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PLAYING)
  game.canvas.closest = originalClosest
  game.canvas.lockMode = originalLockMode
})

check('an unavailable initial pointer lock pauses instead of stranding play', () => {
  const requestId = Symbol('initial-lock-error')
  game.store.set({ phase: PHASE.PLAYING })
  game.activeLockRequest = requestId
  game._handlePointerLockError(requestId)
  assert.equal(store.get().phase, PHASE.PAUSED)
  assert.equal(game.player.enabled, false)
  game.canvas.lockMode = 'success'
  assert.equal(game.resume(), true)
  assert.equal(store.get().phase, PHASE.PLAYING)
})

check('the player can walk: input moves the camera and triggers footsteps', () => {
  const before = game.player.pos.clone()
  game.player.keys.add('KeyW')
  run(game, 2.4)
  game.player.keys.delete('KeyW')
  const moved = Math.hypot(game.player.pos.x - before.x, game.player.pos.z - before.z)
  assert.ok(moved > 1, `moved only ${moved.toFixed(2)}m`)
  assert.ok(audio.calls.filter((name) => name === 'footstep').length > 0, 'no footsteps emitted')
  assert.ok(
    Math.hypot(game.camera.position.x - game.player.pos.x, game.camera.position.z - game.player.pos.z) < 0.05,
    'the camera should follow the player',
  )
  assert.ok(game.camera.position.y > 1.4 && game.camera.position.y < 1.8)
})

check('keyboard look works with and without pointer lock', () => {
  const originalLocked = game.player.locked
  const originalEnabled = game.player.enabled
  game.player.enabled = true
  game.player.locked = true
  const lockedYaw = game.player.yaw
  game.player.keys.add('KeyJ')
  game.player.update(DT)
  assert.notEqual(game.player.yaw, lockedYaw)
  game.player.keys.delete('KeyJ')
  game.player.locked = false
  const freeYaw = game.player.yaw
  game.player.keys.add('KeyL')
  game.player.update(DT)
  assert.notEqual(game.player.yaw, freeYaw)
  game.player.keys.delete('KeyL')
  const disabledYaw = game.player.yaw
  game.player.enabled = false
  game.player.keys.add('KeyJ')
  game.player.update(DT)
  assert.equal(game.player.yaw, disabledYaw)
  game.player.keys.clear()
  game.player.locked = originalLocked
  game.player.enabled = originalEnabled
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
  const { centre, direction } = placeOutsideChamber(game)
  walkTowardChamber(game, 2)
  const offsetX = game.player.pos.x - centre.x
  const offsetZ = game.player.pos.z - centre.z
  const distance = Math.hypot(offsetX, offsetZ)
  const outsideProjection = offsetX * direction.x + offsetZ * direction.z
  assert.ok(distance < 2.4, 'the player did not approach the shut door')
  assert.ok(outsideProjection > 0, 'the player crossed the shut door')
  assert.ok(distance > 1.5, `the player stopped too close to the shut door (${distance.toFixed(2)}m)`)
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
  assert.equal(game.shrines.get(SHRINE_IDS[0]).flameLight.visible, true)
  assert.equal(game.shrines.get(SHRINE_IDS[0]).glimmer.visible, false)
  assert.equal(game.tryLight(), false, 'a lit shrine cannot be lit twice')

  const other = game.shrines.get(SHRINE_IDS[1])
  const far = cellToWorld(other.cell.r, other.cell.c)
  game.player.teleport(far.x + 12, far.z)
  run(game, 0.05)
  assert.equal(store.get().prompt, null, 'no prompt when nowhere near a shrine')
  assert.equal(game.tryLight(), false)
})

check('shrine interaction cannot pass through a wall', () => {
  const shrine = game.shrines.get(SHRINE_IDS[1])
  const { x, z } = cellToWorld(shrine.cell.r, shrine.cell.c)
  const blocked = [
    [1.8, 0],
    [-1.8, 0],
    [0, 1.8],
    [0, -1.8],
  ].find(([dx, dz]) => game._hasWallBetween(x, z, x + dx, z + dz))
  assert.ok(blocked, 'the fixture must include a blocked shrine approach')
  game.player.teleport(x + blocked[0], z + blocked[1])
  game._updatePrompt(store.get())
  assert.equal(store.get().prompt, null)
  assert.equal(game.tryLight(), false)
})

check('the bell rings at 60s: walls sink, the layout swaps, the loop count rises', () => {
  const before = game.wallEntries.map((entry) => `${entry.x},${entry.z}`).join('|')
  game.timeLeft = 0.2
  run(game, 0.4)
  assert.equal(store.get().phase, PHASE.RESET, 'the bell should put the world into RESET')
  assert.equal(game.wallAnimT, 0, 'wall sliding should wait until the layout swap')
  assert.ok(audio.calls.includes('bellSequence'))
  assert.ok(audio.calls.includes('setTension'))
  run(game, RESET_SWAP_AT - game.resetElapsed + 0.2)
  assert.equal(game.player.enabled, false, 'movement should wait for the final wall to rise')
  assert.ok(game.wallEntries.some((entry) => entry.fromX !== undefined), 'walls should pair for the transition glide')
  run(game, RESET_TIMELINE.total - game.resetElapsed + 0.2)
  assert.equal(store.get().phase, PHASE.PLAYING, 'the reset should hand control back')
  assert.equal(store.get().loop, 2)
  assert.ok(store.get().timeLeft > LOOP_SECONDS - 0.5, 'the timer should have refilled')
  assert.equal(store.get().candles[SHRINE_IDS[0]], true, 'the lit shrine must survive the bell')
  const after = game.wallEntries.map((entry) => `${entry.x},${entry.z}`).join('|')
  assert.notEqual(after, before, 'the walls should have moved')
  assert.equal(game.maze.loop, 2)
  assert.ok(game.player.enabled, 'the player should be moving again')
  assert.ok(game.spawnLight.intensity >= 0.6, 'the entrance practical should retain a low anchor')
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

check('lighting the last two candles opens the door once on the next loop', () => {
  const creaksBefore = audio.calls.filter((name) => name === 'doorCreak').length
  for (const id of [SHRINE_IDS[1], SHRINE_IDS[2]]) {
    const shrine = game.shrines.get(id)
    const { x, z } = cellToWorld(shrine.cell.r, shrine.cell.c)
    game.player.teleport(x, z - 1.1)
    run(game, 0.05)
    assert.ok(game.tryLight(), `could not light shrine ${id}`)
  }
  assert.equal(store.get().doorOpen, false, 'the door must wait for the next loop')
  run(game, 0.05)
  assert.equal(game.door.hintLight.visible, true)
  assert.equal(game.door.hintLight.color.getHex(), 0xb07a3c)
  assert.equal(audio.calls.filter((name) => name === 'doorCreak').length, creaksBefore)
  const doorTollsBefore = audio.calls.filter((name) => name === 'bellToll').length

  game.timeLeft = 0.2
  run(game, 1.3)
  assert.equal(store.get().phase, PHASE.RESET)
  assert.equal(store.get().loop, 3)
  assert.equal(store.get().doorOpen, true, 'the door stands open from loop 3')
  assert.equal(game.doorOpen, true)
  assert.equal(game.doorOpened, true)
  assert.equal(game.door.doorLight.visible, true)
  assert.equal(game.door.leakLight.visible, true)
  assert.equal(audio.calls.filter((name) => name === 'doorCreak').length, creaksBefore + 1)
  assert.equal(audio.calls.filter((name) => name === 'bellToll').length, doorTollsBefore + 1)
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length,
    'the door blocker must be gone once the door is open',
  )

  run(game, RESET_TIMELINE.total + 0.2)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.ok(Math.abs(game.door.swing - game.door.target) < 0.005, 'the panel should settle open')
  const openGap = 2 * game.door.panelWidth * (1 - Math.cos(1.5 * game.door.swing))
  assert.ok(openGap > game.player.radius * 2, 'the open door must clear the player diameter')

  game.timeLeft = 0.2
  run(game, RESET_TIMELINE.total + 0.2)
  assert.equal(store.get().loop, 4)
  assert.equal(game.doorOpen, true)
  assert.equal(audio.calls.filter((name) => name === 'doorCreak').length, creaksBefore + 1)
  assert.equal(audio.calls.filter((name) => name === 'bellToll').length, doorTollsBefore + 1)
})

check('walking into the open chamber wins', () => {
  placeOutsideChamber(game)
  walkTowardChamber(game, 2)
  assert.equal(store.get().phase, PHASE.WON)
  assert.ok(audio.calls.includes('winChord'), 'the win chord should play')
  assert.equal(game.door.leakLight.visible, false)
  document.dispatchEvent('pointerlockchange')
  assert.equal(store.get().phase, PHASE.WON)
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
  const ambientStops = audio.calls.filter((name) => name === 'stopAmbient').length
  const silences = audio.calls.filter((name) => name === 'silence').length
  game.restart()
  assert.equal(audio.calls.filter((name) => name === 'stopAmbient').length, ambientStops + 1)
  assert.equal(audio.calls.filter((name) => name === 'silence').length, silences + 1)
  assert.equal(game.resetTollIndex, 0)
  assert.equal(store.get().phase, PHASE.RESET)
  for (const id of SHRINE_IDS) assert.equal(store.get().candles[id], false)
  run(game, RESET_TIMELINE.total + 0.2)
  assert.equal(store.get().phase, PHASE.PLAYING)
  assert.equal(store.get().loop, 1)
  assert.equal(store.get().doorOpen, false)
  assert.ok(store.get().timeLeft > LOOP_SECONDS - 0.5)
  assert.equal(game.doorOpen, false)
  assert.equal(game.door.swing, 0, 'the panel should be shut again')
  assert.equal(
    game.player.colliders.length,
    game.maze.walls.length + 1,
    'the door blocker must be back',
  )
})

check('review presets provide deterministic camera states', () => {
  assert.equal(game.setReviewState('entry'), true)
  const entrance = cellToWorld(game.maze.entrance.r, game.maze.entrance.c)
  assert.ok(Math.hypot(game.player.pos.x - entrance.x, game.player.pos.z - entrance.z) < 0.01)
  assert.equal(game.setReviewState('shrine'), true)
  assert.equal(game.setReviewState('door'), true)
  assert.equal(game.setReviewState('win'), true)
  assert.equal(store.get().phase, PHASE.WON)
  assert.equal(game.doorOpen, true)
  assert.equal(game.door.wide, true)
  assert.equal(game.player.enabled, false)
  assert.equal(game.door.swing, 1)
  assert.equal(game.setReviewState('reset'), true)
  assert.equal(store.get().phase, PHASE.RESET)
  assert.equal(game.setReviewState('invalid'), false)
})

check('review presets clear dirty shrine state before rebuilding', () => {
  game.store.set({ candles: { A: true, B: false, C: false } })
  game._applyShrineStates()
  assert.equal(game.shrines.get(SHRINE_IDS[0]).lit, true)
  assert.equal(game.setReviewState('entry'), true)
  assert.equal(store.get().candles[SHRINE_IDS[0]], false)
  assert.equal(game.shrines.get(SHRINE_IDS[0]).lit, false)
  assert.equal(game.setReviewState('door'), true)
  assert.equal(store.get().candles[SHRINE_IDS[0]], false)
})

check('dispose() tears the world down without throwing', () => {
  game.dispose()
  assert.equal(game.disposed, true)
  assert.equal(document.pointerLockElement, null)
  assert.equal(document.getListenerCount('visibilitychange'), 0)
  assert.equal(document.getListenerCount('pointerlockerror'), 0)
  assert.ok(audio.calls.includes('dispose'))
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
