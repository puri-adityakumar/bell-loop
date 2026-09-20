/**
 * world.js — the vanilla Three.js world: scene, maze, shrines, door, lights,
 * the bell-reset animation and the whole simulation loop.
 *
 * React never touches this file except to construct one instance and to call
 * start()/restart()/dispose(). All game state flows out through the store.
 */
import * as THREE from 'three'
import {
  generateMaze,
  mulberry32,
  GRID,
  CELL_SIZE,
  WALL_HEIGHT,
  WALL_THICKNESS,
  SHRINE_IDS,
  APPROACH_YAW,
  cellToWorld,
} from './maze.js'
import {
  PHASE,
  LOOP_SECONDS,
  RESET_TIMELINE,
  RESET_SWAP_AT,
  advanceTimer,
  applyLightCandle,
  beginLoop,
  candlesLit,
  createInitialState,
  createStore,
  DOOR_WIN_RADIUS,
  isInsideChamber,
  resetFade,
  restartState,
  shouldDoorOpenAtLoopStart,
  wallRiseDelay,
  wallRiseProgress,
} from './loop.js'
import { PlayerController } from './player.js'

/** Palette (PLAN.md §2) — loop-1 atmosphere pass: colder, deader, darker. */
export const PALETTE = Object.freeze({
  bg: 0x030407,
  fog: 0x04060c,
  wall: 0x232832,
  floor: 0x10131a,
  ceiling: 0x07090e,
  wood: 0x3d2a1a,
  flame: 0xffa54a,
  candleLight: 0xff9236,
  ivory: 0xd9cfba,
  brass: 0x7d6c39,
  cold: 0x3a4a5c,
  flashlight: 0xffe2a8,
})

const MAX_WALL_INSTANCES = 400
const FLOOR_SIZE = GRID * CELL_SIZE + 12
const PROMPT_RANGE = 2.4 // metres: an unlit shrine is "in reach"
const INTRO_FADE_SECONDS = 1.4
/** How far the double door swings once it "stands open" (ajar, leaking light). */
const DOOR_AJAR_SWING = 0.12
/** Facing into the maze from the (0,0) corner spawn. */
const ENTRANCE_YAW = -Math.PI * 0.75

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function easeOutCubic01(t) {
  const c = clamp01(t)
  return 1 - (1 - c) ** 3
}

function easeInOut01(t) {
  const c = clamp01(t)
  return c < 0.5 ? 2 * c * c : 1 - ((-2 * c + 2) * (-2 * c + 2)) / 2
}

/** Cheap irregular flicker signal in [-1, 1] (three detuned sines). */
function flickerNoise(t) {
  return (Math.sin(t * 11.7) + Math.sin(t * 5.3 + 1.7) + Math.sin(t * 23.9 + 3.1)) / 3
}

// ---------------------------------------------------------------------------
// procedural textures (canvas only — no downloads)
// ---------------------------------------------------------------------------

/** Smooth value-noise field: a coarse random grid, bilinearly interpolated. */
function valueNoiseField(size, cells, rand) {
  const grid = []
  for (let y = 0; y <= cells; y++) {
    const row = []
    for (let x = 0; x <= cells; x++) row.push(rand())
    grid.push(row)
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const gx = (x / size) * cells
    const gy = (y / size) * cells
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const x1 = Math.min(x0 + 1, cells)
    const y1 = Math.min(y0 + 1, cells)
    const tx = smooth(gx - x0)
    const ty = smooth(gy - y0)
    const top = grid[y0][x0] * (1 - tx) + grid[y0][x1] * tx
    const bottom = grid[y1][x0] * (1 - tx) + grid[y1][x1] * tx
    return top * (1 - ty) + bottom * ty
  }
}

function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Grayscale value-noise tile used as bump + roughness variation so the wall
 * instancing does not read as flat plastic.
 */
function makeNoiseTexture(size = 128, seed = 1337) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const octaves = [
    { cells: 4, weight: 0.5, rand: seededRandom(seed) },
    { cells: 9, weight: 0.3, rand: seededRandom(seed + 1) },
    { cells: 21, weight: 0.2, rand: seededRandom(seed + 2) },
  ].map((o) => ({ ...o, field: valueNoiseField(size, o.cells, o.rand) }))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (const o of octaves) v += o.field(x, y) * o.weight
      const c = Math.max(0, Math.min(255, Math.round(v * 255)))
      const i = (y * size + x) * 4
      image.data[i] = c
      image.data[i + 1] = c
      image.data[i + 2] = c
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  return texture
}

/** Dark cobblestone: rounded, jittered stones in dark grout with speckle. */
function makeCobbleTexture(size = 256, cells = 5, seed = 99) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, size, size)
  const cell = size / cells
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const cx = (i + 0.3 + rand() * 0.4) * cell
      const cy = (j + 0.3 + rand() * 0.4) * cell
      const rx = cell * (0.36 + rand() * 0.1)
      const ry = cell * (0.32 + rand() * 0.1)
      const v = 0.3 + rand() * 0.4
      // the stone
      ctx.fillStyle = `rgb(${Math.round(30 + 44 * v)},${Math.round(34 + 46 * v)},${Math.round(42 + 52 * v)})`
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, rand() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
      // worn highlight, top-left
      ctx.strokeStyle = `rgba(190,200,215,${0.05 + rand() * 0.07})`
      ctx.lineWidth = Math.max(1.5, cell * 0.06)
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, Math.PI * 1.05, Math.PI * 1.75)
      ctx.stroke()
      // seated shadow, bottom-right
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 0.85, ry * 0.85, 0, Math.PI * 0.1, Math.PI * 0.8)
      ctx.stroke()
    }
  }
  // dust speckle
  ctx.globalAlpha = 0.2
  for (let i = 0; i < 1100; i++) {
    const v = Math.floor(rand() * 60)
    ctx.fillStyle = `rgb(${v},${v},${v + 5})`
    ctx.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 1)
  }
  ctx.globalAlpha = 1
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Dark plank ceiling tile: long boards with seams and grain streaks. */
function makePlankTexture(size = 128, boards = 5, seed = 606) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  const boardH = size / boards
  for (let b = 0; b < boards; b++) {
    const v = 0.32 + rand() * 0.3
    ctx.fillStyle = `rgb(${Math.round(34 * v + 10)},${Math.round(24 * v + 7)},${Math.round(15 * v + 5)})`
    ctx.fillRect(0, b * boardH, size, boardH)
    // grain streaks
    ctx.globalAlpha = 0.25
    for (let s = 0; s < 9; s++) {
      ctx.fillStyle = rand() > 0.5 ? '#0a0705' : '#4a3826'
      ctx.fillRect(0, b * boardH + rand() * boardH, size, 1)
    }
    ctx.globalAlpha = 1
    // seam shadow between boards
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, b * boardH, size, 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * Dark stone-brick wall tile (loop 4): rows of offset bricks with recessed
 * mortar lines, per-brick value variation and speckle noise. The same canvas
 * doubles as bumpMap, so mortar lines read as real recesses.
 */
function makeBrickTexture(size = 256, seed = 4242) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  const rows = 6
  const brickH = size / rows
  const brickW = size / 3
  const mortar = 4
  ctx.fillStyle = '#1a1d24' // mortar
  ctx.fillRect(0, 0, size, size)
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * (brickW / 2)
    for (let col = -1; col <= 3; col++) {
      const x = col * brickW + offset
      const y = row * brickH
      // per-brick value: cold grey with occasional warmer stone
      const v = 0.52 + rand() * 0.4
      const warm = rand() < 0.22 ? 10 : 0
      const r = Math.round(38 * v + warm)
      const g = Math.round(42 * v + warm * 0.7)
      const b = Math.round(52 * v)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x + mortar / 2, y + mortar / 2, brickW - mortar, brickH - mortar)
      // chipped highlight on one edge, shadow on the other
      ctx.fillStyle = `rgba(255,255,255,${0.03 + rand() * 0.05})`
      ctx.fillRect(x + mortar / 2, y + mortar / 2, brickW - mortar, 2)
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      ctx.fillRect(x + mortar / 2, y + brickH - mortar / 2 - 2, brickW - mortar, 2)
    }
  }
  // grime speckle + vertical damp streaks
  ctx.globalAlpha = 0.16
  for (let i = 0; i < 1400; i++) {
    const v = Math.floor(rand() * 70)
    ctx.fillStyle = `rgb(${v},${v},${v + 6})`
    ctx.fillRect(Math.floor(rand() * size), Math.floor(rand() * size), 1, 1)
  }
  ctx.globalAlpha = 0.08
  for (let i = 0; i < 7; i++) {
    const x = rand() * size
    ctx.fillStyle = '#06070b'
    ctx.fillRect(x, 0, 3 + rand() * 7, size)
  }
  ctx.globalAlpha = 1
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Soft teardrop glow used by the layered flame sprites (loop 7). */
function makeFlameSpriteTexture(size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size * 0.62, 2, size / 2, size * 0.62, size * 0.5)
  gradient.addColorStop(0, 'rgba(255,240,200,1)')
  gradient.addColorStop(0.35, 'rgba(255,170,70,0.85)')
  gradient.addColorStop(0.7, 'rgba(200,80,20,0.3)')
  gradient.addColorStop(1, 'rgba(120,30,0,0)')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.ellipse(size / 2, size * 0.58, size * 0.32, size * 0.46, 0, 0, Math.PI * 2)
  ctx.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ---------------------------------------------------------------------------
// the game
// ---------------------------------------------------------------------------

export class BellLoopGame {
  /**
   * @param {HTMLElement} container
   * @param {{ store?: object, audio?: object,
   *           createRenderer?: (container: HTMLElement) => object }} [options]
   *   `createRenderer` exists so a headless smoke test (verify-world.mjs) can
   *   drive the whole simulation without a WebGL context.
   */
  constructor(container, options = {}) {
    this.container = container
    this.store = options.store ?? createStore(createInitialState(1, PHASE.START))
    this.audio = options.audio ?? null
    this.disposed = false

    // --- renderer -----------------------------------------------------------
    this.renderer = options.createRenderer
      ? options.createRenderer(container)
      : new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 450, false)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // loop 1: colder cellar dread — darker exposure, desaturated via ACES film
    this.renderer.toneMappingExposure = 0.92
    this.canvas = this.renderer.domElement
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    container.appendChild(this.canvas)

    // --- scene --------------------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(PALETTE.bg)
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, 0.135)
    this.camera = new THREE.PerspectiveCamera(72, this._aspect(), 0.05, 160)

    this.noiseTexture = makeNoiseTexture()
    this.cobbleTexture = makeCobbleTexture()
    this.plankTexture = makePlankTexture()
    this.brickTexture = makeBrickTexture()
    this.flameSpriteTexture = makeFlameSpriteTexture()

    this._buildLights()
    this._buildStaticGeometry()
    this._buildWalls()
    this._buildShrines()
    this._buildDoor()

    // --- player -------------------------------------------------------------
    this.player = new PlayerController(this.camera, this.canvas, {
      onFootstep: (sprinting) => this.audio?.footstep(sprinting),
    })
    this.player.attach()
    this.player.enabled = false

    // --- runtime state ------------------------------------------------------
    this.phase = this.store.get().phase
    this.resetElapsed = 0
    this.swapped = false
    this.nextLoopNumber = 1
    this.introElapsed = 0
    this.introActive = false
    this.startedOnce = false
    this.animTime = 0
    this.nearestShrine = null
    this.doorOpened = false
    this.maze = null
    this.wallEntries = []
    this.meterAccum = 0
    /** Authoritative countdown; mirror into the store at ~20Hz. */
    this.timeLeft = LOOP_SECONDS
    this.clock = new THREE.Clock()

    // --- input --------------------------------------------------------------
    this._onKeyDown = (e) => {
      if (e.code === 'KeyE' || e.code === 'Space') this.tryLight()
    }
    this._onMouseDown = () => {
      this.tryLight()
      if (this.startedOnce && this.phase !== PHASE.WON && !this.player.locked) this.player.requestLock()
    }
    window.addEventListener('keydown', this._onKeyDown)
    this.canvas.addEventListener('mousedown', this._onMouseDown)

    this._onWindowResize = () => this.resize()
    window.addEventListener('resize', this._onWindowResize)
    this._resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this._resizeObserver?.observe(container)

    // --- first layout; walls stay sunk in the floor until BEGIN -------------
    this._loadMaze(1, { doorOpen: false })
    this._updateWallMatrices(() => 0)
    this.store.set({ fade: this.phase === PHASE.START ? 1 : 0 })

    this._animate = this._animate.bind(this)
    this.rafId = requestAnimationFrame(this._animate)
  }

  _aspect() {
    return (this.container.clientWidth || 800) / Math.max(1, this.container.clientHeight || 450)
  }

  resize() {
    if (this.disposed) return
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 450
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  // -------------------------------------------------------------------------
  // scene construction
  // -------------------------------------------------------------------------

  _buildLights() {
    // a whisper of ambient so unlit faces are not pure black (colder blue now)
    this.hemisphere = new THREE.HemisphereLight(0x141c2a, 0x030407, 0.2)
    this.scene.add(this.hemisphere)

    // the flashlight (loop 6): a warm lamp cone with a soft penumbra edge. It
    // is the scene's ONLY shadow-casting light — candle points stay shadow-free
    // for speed — and its target lags behind the view direction (that lag is
    // the horror).
    this.flashlight = new THREE.SpotLight(0xffdca0, 55, 34, 0.5, 0.62, 1.8)
    this.flashlight.castShadow = true
    this.flashlight.shadow.mapSize.set(1024, 1024)
    this.flashlight.shadow.camera.near = 0.2
    this.flashlight.shadow.camera.far = 32
    this.flashlight.shadow.bias = -0.0015
    this.flashlight.shadow.normalBias = 0.03
    this.flashlightTarget = new THREE.Object3D()
    this.flashlight.target = this.flashlightTarget
    this.scene.add(this.flashlight)
    this.scene.add(this.flashlightTarget)

    // a faint warm lamp at the entrance so every reset has an anchor point
    this.spawnLight = new THREE.PointLight(0xffd9a0, 0, 9, 2)
    this.scene.add(this.spawnLight)
  }

  _buildStaticGeometry() {
    const repeat = FLOOR_SIZE / (CELL_SIZE * 2)
    this.cobbleTexture.repeat.set(repeat, repeat)
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({
        color: PALETTE.floor,
        map: this.cobbleTexture,
        bumpMap: this.cobbleTexture,
        bumpScale: 0.05,
        roughness: 1,
        metalness: 0,
      }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.scene.add(this.floor)

    // ceiling: dark planks
    const plankRepeat = FLOOR_SIZE / (CELL_SIZE * 4)
    this.plankTexture.repeat.set(plankRepeat, plankRepeat)
    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({
        color: PALETTE.ceiling,
        map: this.plankTexture,
        roughness: 1,
        metalness: 0,
      }),
    )
    this.ceiling.rotation.x = Math.PI / 2
    this.ceiling.position.y = WALL_HEIGHT
    this.scene.add(this.ceiling)

    // --- loop 5: dark wooden ceiling beams every few cells ------------------
    const beamMaterial = new THREE.MeshStandardMaterial({
      color: 0x241a10,
      roughness: 0.92,
      metalness: 0.04,
      bumpMap: this.noiseTexture,
      bumpScale: 0.02,
    })
    const span = GRID * CELL_SIZE
    const beamStep = CELL_SIZE * 3
    const beamY = WALL_HEIGHT - 0.09
    const longBeamGeometry = new THREE.BoxGeometry(span + 6, 0.16, 0.26)
    const crossBeamGeometry = new THREE.BoxGeometry(0.26, 0.16, span + 6)
    for (let k = -2; k * beamStep <= span + beamStep; k++) {
      const pos = k * beamStep + span / 2
      const alongX = new THREE.Mesh(longBeamGeometry, beamMaterial)
      alongX.position.set(span / 2, beamY, pos)
      const alongZ = new THREE.Mesh(crossBeamGeometry, beamMaterial)
      alongZ.position.set(pos, beamY, span / 2)
      for (const beam of [alongX, alongZ]) {
        beam.castShadow = true
        beam.receiveShadow = true
        this.scene.add(beam)
      }
    }

    // --- occasional hanging chains (curved tube segments) --------------------
    const chainMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2d33,
      roughness: 0.55,
      metalness: 0.8,
    })
    const chainRng = mulberry32(0xca10) // fixed stream, static dressing
    const anchors = [
      cellToWorld(0, 0), // always open: the entrance cell
      cellToWorld(7, 7), // always open: the centre chamber
    ]
    for (let i = 0; i < 4; i++) {
      const c = Math.floor(chainRng() * GRID)
      const r = Math.floor(chainRng() * GRID)
      anchors.push(cellToWorld(r, c))
    }
    for (const anchor of anchors) {
      const sag = 0.22 + chainRng() * 0.3
      const drop = 0.7 + chainRng() * 0.5
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(anchor.x, WALL_HEIGHT - 0.02, anchor.z),
        new THREE.Vector3(anchor.x + sag * 0.4, WALL_HEIGHT - drop * 0.55 - sag * 0.2, anchor.z + sag * 0.3),
        new THREE.Vector3(anchor.x + sag * 0.7, WALL_HEIGHT - drop, anchor.z + sag * 0.6),
      ])
      const link = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.022, 6), chainMaterial)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 5, 10), chainMaterial)
      ring.position.set(anchor.x, WALL_HEIGHT - 0.02, anchor.z)
      this.scene.add(link, ring)
    }
  }

  /**
   * Walls are two InstancedMeshes (one per orientation) of a single box
   * geometry with per-instance colour jitter and a shared noise bump/roughness
   * map, so 240+ wall segments cost two draw calls.
   */
  _buildWalls() {
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.wall,
      // loop 4: real stone-brick surface — the map carries the brick pattern,
      // the same tile doubles as bumpMap so mortar lines recess
      map: this.brickTexture,
      roughness: 0.95,
      metalness: 0,
      bumpMap: this.brickTexture,
      bumpScale: 0.035,
      roughnessMap: this.noiseTexture,
    })
    this.wallMeshX = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CELL_SIZE + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
      this.wallMaterial,
      MAX_WALL_INSTANCES,
    )
    this.wallMeshZ = new THREE.InstancedMesh(
      new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, CELL_SIZE + WALL_THICKNESS),
      this.wallMaterial,
      MAX_WALL_INSTANCES,
    )
    for (const mesh of [this.wallMeshX, this.wallMeshZ]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.count = 0
      this.scene.add(mesh)
    }
    this._wallMatrix = new THREE.Matrix4()
    this._wallOffset = new THREE.Vector3()
    this._wallQuat = new THREE.Quaternion()
    this._wallScale = new THREE.Vector3(1, 1, 1)
    this._wallColor = new THREE.Color()
  }

  /**
   * Write every wall instance, offsetting each one's Y by its rise progress:
   * 0 = sunk below the floor, 1 = standing.
   * @param {(entry: object) => number} progressFor
   */
  _updateWallMatrices(progressFor) {
    const counts = { x: 0, z: 0 }
    for (const entry of this.wallEntries) {
      let p = progressFor(entry)
      if (p < 0) p = 0
      else if (p > 1) p = 1
      const y = entry.y - (1 - p) * (WALL_HEIGHT + 0.5)
      this._wallOffset.set(entry.x, y, entry.z)
      this._wallMatrix.compose(this._wallOffset, this._wallQuat, this._wallScale)
      const mesh = entry.axis === 'x' ? this.wallMeshX : this.wallMeshZ
      const index = counts[entry.axis]
      mesh.setMatrixAt(index, this._wallMatrix)
      this._wallColor.setRGB(entry.tintR, entry.tintG, entry.tintB)
      mesh.setColorAt(index, this._wallColor)
      counts[entry.axis] += 1
    }
    this.wallMeshX.count = counts.x
    this.wallMeshZ.count = counts.z
    this.wallMeshX.instanceMatrix.needsUpdate = true
    this.wallMeshZ.instanceMatrix.needsUpdate = true
    if (this.wallMeshX.instanceColor) this.wallMeshX.instanceColor.needsUpdate = true
    if (this.wallMeshZ.instanceColor) this.wallMeshZ.instanceColor.needsUpdate = true
  }

  /**
   * Build a loop's layout: maze graph, wall instances (with per-wall rise
   * delays), the player's colliders + spawn, the three shrines and the door.
   */
  _loadMaze(loopNumber, { doorOpen = false } = {}) {
    const maze = generateMaze(loopNumber)
    this.maze = maze
    const entrance = cellToWorld(maze.entrance.r, maze.entrance.c)
    const jitterRng = mulberry32(0x9e37 + loopNumber * 7919)
    let maxDistance = 1
    this.wallEntries = maze.walls.map((wall) => {
      const distance = Math.hypot(wall.cx - entrance.x, wall.cz - entrance.z)
      if (distance > maxDistance) maxDistance = distance
      // per-instance tint: slight value + warm/cool drift so no two walls clone
      const v = 0.86 + jitterRng() * 0.2
      const tint = jitterRng() < 0.5 ? 1 : -1
      return {
        axis: wall.axis,
        x: wall.cx,
        y: WALL_HEIGHT / 2,
        z: wall.cz,
        distance,
        tintR: v + tint * 0.035 * jitterRng(),
        tintG: v + tint * 0.012 * jitterRng(),
        tintB: v - tint * 0.03 * jitterRng(),
        delay: 0,
      }
    })
    for (const entry of this.wallEntries) {
      entry.delay = wallRiseDelay(entry.distance, maxDistance)
    }

    this.player.setColliders(maze.walls)
    this.player.teleport(entrance.x, entrance.z, ENTRANCE_YAW)
    this.spawnLight.position.set(entrance.x, 1.95, entrance.z)
    this.spawnElapsed = 0

    this._repositionShrines(maze)
    this._positionDoor(maze)
    this._setDoorOpen(doorOpen, true)
    return maze
  }

  // -------------------------------------------------------------------------
  // shrines + candles
  // -------------------------------------------------------------------------

  /**
   * Proper 3D candle shrines (loop 2): a chipped stone pedestal — beveled
   * square base, fluted column, irregular chipped cap — an iron drip-ring
   * holder, and a stubby wax candle with drips frozen down its side. Built
   * once, moved per loop.
   */
  _buildShrines() {
    // cold graveyard stone; the shared noise tile reads as pitted surface
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0x3d434e,
      roughness: 0.97,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.035,
    })
    const stoneDark = new THREE.MeshStandardMaterial({
      color: 0x2c313a,
      roughness: 0.98,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.045,
    })
    const ironMaterial = new THREE.MeshStandardMaterial({
      color: 0x22252b,
      roughness: 0.52,
      metalness: 0.85,
    })
    this.shrines = new Map()
    const dripRng = mulberry32(0xbea2) // one stream, so the three shrines differ
    for (const id of SHRINE_IDS) {
      const group = new THREE.Group()

      // beveled square plinth (a 4-sided frustum rotated 45° reads as chamfered)
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.47, 0.16, 4), stoneDark)
      base.position.y = 0.08
      base.rotation.y = Math.PI / 4

      // fluted column with a waist
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.62, 6), stoneMaterial)
      column.position.y = 0.47
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 6), stoneDark)
      collar.position.y = 0.72

      // chipped cap: irregular 7-gon slab, uneven rim
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.2, 0.1, 7), stoneMaterial)
      cap.position.y = 0.83
      cap.rotation.y = dripRng() * Math.PI
      for (const part of [base, column, collar, cap]) {
        part.castShadow = true
        part.receiveShadow = true
      }

      // iron holder ring + drip dish on the cap
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 10), ironMaterial)
      dish.position.y = 0.9
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 6, 14), ironMaterial)
      ring.rotation.x = Math.PI / 2
      ring.position.y = 0.935
      dish.castShadow = true

      // the candle: wax stub with drips frozen down its side
      const candleMaterial = new THREE.MeshStandardMaterial({
        color: PALETTE.ivory,
        roughness: 0.62,
      })
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.34, 9), candleMaterial)
      candle.position.y = 1.05
      candle.castShadow = true
      const dripCount = 3 + Math.floor(dripRng() * 3)
      const drips = []
      for (let i = 0; i < dripCount; i++) {
        const h = 0.07 + dripRng() * 0.13
        const angle = dripRng() * Math.PI * 2
        const r = 0.082
        const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.026, h, 5), candleMaterial)
        drip.position.set(Math.cos(angle) * r, 1.12 - h / 2, Math.sin(angle) * r)
        const blob = new THREE.Mesh(new THREE.SphereGeometry(0.026, 5, 4), candleMaterial)
        blob.position.set(Math.cos(angle) * r, 1.12 - h, Math.sin(angle) * r)
        blob.scale.set(1, 0.55, 1)
        drips.push(drip, blob)
      }

      // layered sprite flame (loop 7): three additive teardrops that wobble at
      // different frequencies, replacing the old stretched sphere
      const flames = [0, 1, 2].map((layer) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.flameSpriteTexture,
            color: PALETTE.flame,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        )
        sprite.position.y = 1.3 + layer * 0.02
        sprite.visible = false
        return sprite
      })

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 10),
        new THREE.MeshBasicMaterial({
          color: PALETTE.flame,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      )
      halo.position.y = 1.34

      // tiny embers rising from a lit candle (loop 7): one Points cloud per
      // shrine, recycled positions, only simulated while lit
      const EMBER_COUNT = 12
      const emberPositions = new Float32Array(EMBER_COUNT * 3)
      const emberSpeeds = new Float32Array(EMBER_COUNT)
      for (let i = 0; i < EMBER_COUNT; i++) {
        emberPositions[i * 3] = (dripRng() - 0.5) * 0.06
        emberPositions[i * 3 + 1] = 1.2 + dripRng() * 0.5
        emberPositions[i * 3 + 2] = (dripRng() - 0.5) * 0.06
        emberSpeeds[i] = 0.18 + dripRng() * 0.3
      }
      const emberGeometry = new THREE.BufferGeometry()
      emberGeometry.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3))
      const embers = new THREE.Points(
        emberGeometry,
        new THREE.PointsMaterial({
          color: 0xffb35c,
          size: 0.035,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      )
      embers.visible = false
      embers.frustumCulled = false

      const flameLight = new THREE.PointLight(PALETTE.candleLight, 0, 8, 2)
      flameLight.position.y = 1.38

      // a cold glimmer marks an UNLIT shrine: findable in the dark, clearly off
      const glimmer = new THREE.PointLight(PALETTE.cold, 1.2, 2.8, 2)
      glimmer.position.y = 1.15

      group.add(
        base,
        column,
        collar,
        cap,
        dish,
        ring,
        candle,
        ...drips,
        ...flames,
        halo,
        embers,
        flameLight,
        glimmer,
      )
      this.scene.add(group)

      this.shrines.set(id, {
        id,
        group,
        candle,
        candleMaterial,
        flames,
        embers,
        emberSpeeds,
        halo,
        flameLight,
        glimmer,
        cell: null,
        lit: false,
        level: 0, // ramps 0 -> 1 while the candle ignites
        flicker: (id.charCodeAt(0) - 64) * 3.7,
        baseIntensity: 14,
      })
    }
    // waxy-dead unlit candle: greyer, duller wax, melted sheen gone
    this._unlitCandleColor = new THREE.Color(0x57554e)
    this._ivoryColor = new THREE.Color(PALETTE.ivory)
  }

  _repositionShrines(maze) {
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      const cell = maze.shrineCells[id]
      shrine.cell = cell
      const { x, z } = cellToWorld(cell.r, cell.c)
      shrine.group.position.set(x, 0, z)
      // deterministic yaw per shrine id so the three pedestals never line up
      shrine.group.rotation.y = ((id.charCodeAt(0) - 65) * 2.1 + maze.loop * 0.7) % (Math.PI * 2)
    }
    this._applyShrineStates()
  }

  /** Push the persisted lit/unlit truth from the store into the 3D shrines. */
  _applyShrineStates() {
    const { candles } = this.store.get()
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      const lit = Boolean(candles[id])
      shrine.lit = lit
      shrine.level = lit ? 1 : 0
      for (const flame of shrine.flames) flame.visible = lit
      shrine.embers.visible = lit
      shrine.halo.visible = lit
      shrine.flameLight.intensity = lit ? shrine.baseIntensity : 0
      shrine.flameLight.distance = lit ? 8 : 0
      shrine.glimmer.intensity = lit ? 0 : 1.2
      // waxy-dead when unlit: greyer, duller wax
      shrine.candleMaterial.color.copy(lit ? this._ivoryColor : this._unlitCandleColor)
      shrine.candleMaterial.roughness = lit ? 0.62 : 0.88
    }
  }

  /** Light a shrine for good (the store is the source of truth). */
  _lightShrine(shrine) {
    if (!shrine || shrine.lit) return false
    this.store.update((state) => applyLightCandle(state, shrine.id))
    shrine.lit = true
    shrine.level = 0
    for (const flame of shrine.flames) flame.visible = true
    shrine.embers.visible = true
    shrine.halo.visible = true
    shrine.glimmer.intensity = 0
    shrine.candleMaterial.color.copy(this._ivoryColor)
    shrine.candleMaterial.roughness = 0.62
    this.audio?.candleWhoosh()
    if (candlesLit(this.store.get().candles) === SHRINE_IDS.length) {
      // all three are burning: something changed at the centre of the maze
      this.audio?.bellToll(0.25, 330, 0.3)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // the exit door at the centre of the maze
  // -------------------------------------------------------------------------

  /**
   * The exit door at the centre of the maze (loop 3 rework): an arched stone
   * frame — jambs plus radial voussoirs with a keystone — holding an
   * iron-banded double door. Closed while the shrines burn; slightly ajar with
   * warm light leaking through the centre crack once it stands open; it can
   * then swing fully wide (the win sequence). One canonical "approach from the
   * north" frame is yawed into place, so one geometry serves all approaches.
   */
  _buildDoor() {
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.wood,
      roughness: 0.82,
      metalness: 0.08,
    })
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.brass,
      roughness: 0.45,
      metalness: 0.7,
    })
    const ironMaterial = new THREE.MeshStandardMaterial({
      color: 0x23262c,
      roughness: 0.5,
      metalness: 0.82,
    })
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0x39404b,
      roughness: 0.96,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.04,
    })
    const group = new THREE.Group()
    const openingHalf = CELL_SIZE / 2 - WALL_THICKNESS / 2 // 1.33m
    const frameZ = -CELL_SIZE / 2

    // --- arched stone frame -------------------------------------------------
    const jambGeometry = new THREE.BoxGeometry(0.3, 2.24, 0.52)
    const jambLeft = new THREE.Mesh(jambGeometry, stoneMaterial)
    jambLeft.position.set(-openingHalf - 0.02, 1.12, frameZ)
    const jambRight = new THREE.Mesh(jambGeometry, stoneMaterial)
    jambRight.position.set(openingHalf + 0.02, 1.12, frameZ)
    // voussoirs: radial wedge boxes along a squashed semicircle + a keystone
    const voussoirs = []
    const ARCH_SPRING = 2.16
    const ARCH_RISE = 0.56
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI - (i / 8) * Math.PI
      const isKeystone = i === 4
      const wedge = new THREE.Mesh(
        new THREE.BoxGeometry(isKeystone ? 0.46 : 0.4, isKeystone ? 0.26 : 0.22, 0.56),
        stoneMaterial,
      )
      wedge.position.set(
        Math.cos(a) * (openingHalf + 0.06),
        ARCH_SPRING + Math.sin(a) * ARCH_RISE,
        frameZ,
      )
      wedge.rotation.z = a
      voussoirs.push(wedge)
    }
    for (const part of [jambLeft, jambRight, ...voussoirs]) {
      part.castShadow = true
      part.receiveShadow = true
    }

    // --- iron-banded double door --------------------------------------------
    const hingeL = new THREE.Group()
    hingeL.position.set(-openingHalf + 0.14, 0, frameZ)
    const hingeR = new THREE.Group()
    hingeR.position.set(openingHalf - 0.14, 0, frameZ)
    const panelWidth = openingHalf - 0.18
    const panelGeometry = new THREE.BoxGeometry(panelWidth, 2.34, 0.1)
    const panelL = new THREE.Mesh(panelGeometry, woodMaterial)
    panelL.position.set(panelWidth / 2, 1.17, 0)
    const panelR = new THREE.Mesh(panelGeometry, woodMaterial)
    panelR.position.set(-panelWidth / 2, 1.17, 0)
    for (const panel of [panelL, panelR]) {
      panel.castShadow = true
      panel.receiveShadow = true
    }
    // two iron bands per leaf + a ring handle
    for (const hinge of [hingeL, hingeR]) {
      const sign = hinge === hingeL ? 1 : -1
      for (const bandY of [0.52, 1.78]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(panelWidth * 0.94, 0.09, 0.035), ironMaterial)
        band.position.set(sign * (panelWidth / 2), bandY, 0.07)
        hinge.add(band)
      }
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 6, 14), brassMaterial)
      handle.position.set(sign * (panelWidth - 0.22), 1.12, 0.09)
      hinge.add(handle)
    }
    hingeL.add(panelL)
    hingeR.add(panelR)

    // what is beyond: a warm plane on the far wall of the chamber, plus a glow
    const beyond = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    )
    beyond.position.set(0, 1.35, CELL_SIZE / 2 - 0.4)
    beyond.rotation.y = Math.PI
    beyond.visible = false

    // the crack: a thin warm sliver + a weak light that leak into the corridor
    const leak = new THREE.Mesh(
      new THREE.PlaneGeometry(0.045, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true, opacity: 0.85 }),
    )
    leak.position.set(0, 1.2, frameZ + 0.06)
    leak.visible = false
    const leakLight = new THREE.PointLight(0xffb066, 0, 5.5, 2)
    leakLight.position.set(0, 1.3, frameZ - 0.35)
    leakLight.visible = false

    const doorLight = new THREE.PointLight(0xffb066, 0, 18, 2)
    doorLight.position.set(0, 1.5, 0)
    const hintLight = new THREE.PointLight(0x2a3a55, 1.1, 6.5, 2)
    hintLight.position.set(0, 1.4, -CELL_SIZE / 2 - 0.6)

    group.add(jambLeft, jambRight, ...voussoirs, hingeL, hingeR, beyond, leak, leakLight, doorLight, hintLight)
    this.scene.add(group)

    this.door = {
      group,
      hingeL,
      hingeR,
      beyond,
      leak,
      leakLight,
      doorLight,
      hintLight,
      swing: 0,
      target: 0,
      wide: false, // true during the win sequence: swing fully open
    }
    this.doorOpen = false
  }

  _positionDoor(maze) {
    const center = cellToWorld(maze.center.r, maze.center.c)
    this.door.group.position.set(center.x, 0, center.z)
    this.door.group.rotation.y = APPROACH_YAW[maze.centerApproach] ?? 0
    this.doorCenter = center
  }

  /** The closed panel is solid: it blocks the only way into the chamber. */
  _doorWallSegment() {
    const { x, z } = this.doorCenter
    const half = CELL_SIZE / 2
    const halfWidth = CELL_SIZE / 2 - WALL_THICKNESS / 2 - 0.16
    const thickness = 0.1
    switch (this.maze.centerApproach) {
      case 'S':
        return { cx: x, cz: z + half, hx: halfWidth, hz: thickness }
      case 'E':
        return { cx: x + half, cz: z, hx: thickness, hz: halfWidth }
      case 'W':
        return { cx: x - half, cz: z, hx: thickness, hz: halfWidth }
      default:
        return { cx: x, cz: z - half, hx: halfWidth, hz: thickness }
    }
  }

  _refreshColliders() {
    if (!this.maze) return
    const segments = this.doorOpen ? this.maze.walls : [...this.maze.walls, this._doorWallSegment()]
    this.player.setColliders(segments)
  }

  /** @param {boolean} open @param {boolean} [instant] skip the creak + swing */
  _setDoorOpen(open, instant = false) {
    const wasOpen = this.doorOpen
    this.doorOpen = open
    this.door.target = open ? (this.door.wide ? 1 : DOOR_AJAR_SWING) : 0
    if (instant) {
      this.door.swing = this.door.target
      this._applyDoorSwing()
    }
    this.door.beyond.visible = open
    this.door.leak.visible = open && !this.door.wide
    this.door.leakLight.visible = open
    this.door.hintLight.visible = !open
    this._refreshColliders()
    if (open && !wasOpen && !instant) {
      this.audio?.doorCreak(1.4)
      this.doorOpened = true
    }
  }

  /** Both leaves swing outward symmetrically: 0 = shut, 1 = wide open. */
  _applyDoorSwing() {
    this.door.hingeL.rotation.y = -1.5 * this.door.swing
    this.door.hingeR.rotation.y = 1.5 * this.door.swing
  }

  // -------------------------------------------------------------------------
  // simulation
  // -------------------------------------------------------------------------

  _animate() {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this._animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  update(dt) {
    this.animTime += dt
    const state = this.store.get()
    this.phase = state.phase
    switch (this.phase) {
      case PHASE.PLAYING:
        this._updatePlaying(dt, state)
        break
      case PHASE.RESET:
        this._updateReset(dt)
        break
      case PHASE.START:
        // loop 10: the title screen breathes — the camera drifts very slowly
        // in place so the fog visibly swirls behind the overlay
        this._updateStartDrift(dt)
        break
      default:
        // WON (frozen scene)
        break
    }
    this._updateFlashlight(dt)
    this._updateShrines(dt)
    this._updateDoor(dt)
    this._updateSpawnLight(dt)
  }

  /** loop 10: slow breathing camera drift while the title screen is up. */
  _updateStartDrift(dt) {
    if (!this._startDriftBase) {
      this._startDriftBase = {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
        yaw: this.player.yaw,
      }
    }
    const t = this.animTime
    const base = this._startDriftBase
    this.camera.position.set(
      base.x + Math.sin(t * 0.11) * 0.22,
      base.y + Math.sin(t * 0.07 + 1.3) * 0.045,
      base.z + Math.cos(t * 0.09) * 0.22,
    )
    this.player.yaw = base.yaw + Math.sin(t * 0.05) * 0.06
    this.player.pitch = Math.sin(t * 0.06 + 0.7) * 0.02
    this.player._applyCamera()
  }

  _updatePlaying(dt, state) {
    // one-off reveal: the walls rise out of the floor while the black lifts
    if (this.introActive) {
      this.introElapsed += dt
      const elapsed = this.introElapsed
      this._updateWallMatrices((entry) => easeOutCubic01((elapsed - 0.2 - entry.delay * 0.6) / 1.1))
      this.store.set({ fade: 1 - easeInOut01(elapsed / INTRO_FADE_SECONDS) })
      if (elapsed > INTRO_FADE_SECONDS + 1.2) {
        this.introActive = false
        this._updateWallMatrices(() => 1)
        this.store.set({ fade: 0 })
      }
    }

    this.player.update(dt)

    // The world owns the countdown; the store only mirrors it at ~20Hz so the
    // HUD does not re-render 60 times a second.
    this.timeLeft = advanceTimer(this.timeLeft, dt)
    this.meterAccum += dt
    if (this.meterAccum >= 0.05 || this.timeLeft <= 0) {
      this.meterAccum = 0
      this.store.set({ timeLeft: this.timeLeft })
    }
    if (this.timeLeft <= 0) {
      this._beginReset()
      return
    }
    this._updatePrompt(state)
    this._checkWin()
  }

  /** The HUD prompt lights up when an unlit shrine is within reach. */
  _updatePrompt(state) {
    let nearest = null
    let nearestDistance = Infinity
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      if (shrine.lit) continue
      const distance = Math.hypot(
        this.player.pos.x - shrine.group.position.x,
        this.player.pos.z - shrine.group.position.z,
      )
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = shrine
      }
    }
    this.nearestShrine = nearestDistance <= PROMPT_RANGE ? nearest : null
    const prompt = this.nearestShrine ? 'light' : null
    if (prompt !== state.prompt) this.store.set({ prompt })
  }

  _checkWin() {
    if (!this.doorOpen || !this.doorCenter) return
    if (isInsideChamber(this.player.pos, this.doorCenter, DOOR_WIN_RADIUS)) this._win()
  }

  _win() {
    this.player.enabled = false
    this.nearestShrine = null
    this.store.set({ phase: PHASE.WON, prompt: null, fade: 0 })
    // the double door swings fully wide as the win light floods in
    this.door.wide = true
    this.door.target = 1
    this.door.leak.visible = false
    this.audio?.winChord()
    if (typeof document.exitPointerLock === 'function') document.exitPointerLock()
  }

  // -------------------------------------------------------------------------
  // the bell: fade out -> walls sink -> layout swaps behind black -> walls rise
  // -------------------------------------------------------------------------

  _beginReset() {
    this.nextLoopNumber = this.store.get().loop + 1
    this.resetElapsed = 0
    this.swapped = false
    this.player.enabled = true // still free to walk while the walls sink
    this.store.set({ phase: PHASE.RESET, prompt: null })
    this.audio?.bellSequence(RESET_TIMELINE.tolls, RESET_TIMELINE.tollSpacing)
    this.timeLeft = LOOP_SECONDS
  }

  _updateReset(dt) {
    this.resetElapsed += dt
    const elapsed = this.resetElapsed

    if (!this.swapped && elapsed >= RESET_SWAP_AT) {
      this.swapped = true
      this._swapLoop()
    }

    if (this.swapped) {
      this._updateWallMatrices((entry) => wallRiseProgress(elapsed, entry.delay))
      // frozen while the floor is still swallowing the layout
      this.player.enabled = elapsed > RESET_SWAP_AT + RESET_TIMELINE.rise * 0.45
    } else {
      this._updateWallMatrices(() => 1 - easeInOut01(elapsed / RESET_SWAP_AT))
      this.player.update(dt)
    }

    this.store.set({ fade: resetFade(elapsed), timeLeft: LOOP_SECONDS })
    if (elapsed >= RESET_TIMELINE.total) {
      this.player.enabled = true
      this.store.set({ phase: PHASE.PLAYING })
    }
  }

  /** Everything the bell changes: layout, shrines, door, spawn, loop counter. */
  _swapLoop() {
    const candles = this.store.get().candles
    const doorOpen = shouldDoorOpenAtLoopStart(candles)
    this._loadMaze(this.nextLoopNumber, { doorOpen })
    this._updateWallMatrices(() => 0) // the new walls wait under the floor
    this.store.update((state) => beginLoop(state, this.nextLoopNumber, PHASE.RESET))
    this.timeLeft = LOOP_SECONDS
    if (doorOpen && !this.doorOpened) {
      // a second, lower toll tells the player the door at the centre is open
      this.audio?.bellToll(1.6, 165, 0.35)
    }
  }

  // -------------------------------------------------------------------------
  // per-frame visuals
  // -------------------------------------------------------------------------

  _updateFlashlight(dt) {
    if (!this._flashDesired) {
      this._flashDesired = new THREE.Vector3()
      this._forward = new THREE.Vector3()
      this._flashDesired.set(0, 0, 0)
    }
    // slightly above the eye, so the cone sits a touch low and reads as a lamp
    this.flashlight.position.set(
      this.camera.position.x,
      this.camera.position.y + 0.14,
      this.camera.position.z,
    )
    this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
    this._flashDesired.copy(this.camera.position).addScaledVector(this._forward, 9)
    // the lag: the cone catches up with where you are looking
    this.flashlightTarget.position.lerp(this._flashDesired, 1 - Math.exp(-5.5 * dt))

    // loop 6: battery dying as the bell approaches — in the last 8 seconds the
    // lamp browns out in irregular dips, then recovers after the reset
    const BASE = 55
    let desired = BASE
    if (this.phase === PHASE.PLAYING && this.timeLeft < 8) {
      const danger = 1 - this.timeLeft / 8
      const dip = Math.max(0, flickerNoise(this.animTime * 2.3 + 1.4)) * danger
      desired = BASE * (1 - 0.5 * dip)
    } else if (this.phase === PHASE.RESET && this.resetElapsed < 1.2) {
      desired = BASE * 0.72 // the toll knocks the battery for a moment
    }
    this.flashlight.intensity += (desired - this.flashlight.intensity) * (1 - Math.exp(-11 * dt))
    // colour cools as it browns out
    const warmth = this.flashlight.intensity / BASE
    this.flashlight.color.setRGB(1, 0.8 + 0.06 * warmth, 0.55 + 0.13 * warmth)
  }

  _updateShrines(dt) {
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      if (!shrine.lit) continue
      shrine.level += (1 - shrine.level) * (1 - Math.exp(-4 * dt))
      const noise = flickerNoise(this.animTime + shrine.flicker)
      const n01 = 0.5 + 0.5 * noise
      // layered flame: each layer bobs and sways at its own frequency
      shrine.flames.forEach((flame, layer) => {
        const wobble = flickerNoise(this.animTime * (1.6 + layer * 0.7) + shrine.flicker + layer * 2.1)
        flame.position.x = wobble * (0.014 + layer * 0.008)
        flame.position.y = 1.3 + layer * 0.02 + n01 * 0.015
        const s = (1.1 - layer * 0.28) * shrine.level
        flame.scale.set(s * (0.9 + 0.1 * n01), s * (1.7 + 0.25 * n01), 1)
        flame.material.opacity = (0.8 - layer * 0.22) * shrine.level * (0.85 + 0.15 * n01)
      })
      // pulsing point light: intensity flicker + breathing radius
      shrine.flameLight.intensity = shrine.baseIntensity * shrine.level * (0.82 + 0.18 * n01)
      shrine.flameLight.distance = 7.4 + 1.4 * n01
      shrine.halo.scale.setScalar(0.9 + 0.25 * n01)
      shrine.halo.material.opacity = 0.1 + 0.06 * n01

      // embers: rise, drift, recycle back into the candle top
      const positions = shrine.embers.geometry.attributes.position
      const array = positions.array
      for (let i = 0; i < shrine.emberSpeeds.length; i++) {
        const idx = i * 3
        array[idx + 1] += shrine.emberSpeeds[i] * dt
        array[idx] += Math.sin(this.animTime * 2.1 + i * 1.7) * 0.02 * dt
        array[idx + 2] += Math.cos(this.animTime * 1.7 + i * 2.3) * 0.02 * dt
        if (array[idx + 1] > 1.95) {
          array[idx] = (Math.random() - 0.5) * 0.06
          array[idx + 1] = 1.2
          array[idx + 2] = (Math.random() - 0.5) * 0.06
        }
      }
      positions.needsUpdate = true
    }
  }

  _updateDoor(dt) {
    const door = this.door
    if (Math.abs(door.swing - door.target) > 0.0005) {
      door.swing += (door.target - door.swing) * (1 - Math.exp(-3.2 * dt))
      this._applyDoorSwing()
    }
    if (door.doorLight.visible) {
      door.doorLight.intensity = 15 + Math.sin(this.animTime * 1.7) * 2.5
    }
    if (door.leakLight.visible) {
      // warm light breathing through the crack; gone once the door is wide
      door.leakLight.intensity = (1.6 + Math.sin(this.animTime * 1.7) * 0.5) * (1 - door.swing)
      door.leak.material.opacity = 0.85 * (1 - door.swing)
    }
  }

  /** A warm lamp at the entrance, brightest right after a spawn, then fading. */
  _updateSpawnLight(dt) {
    if (!this.startedOnce) {
      this.spawnLight.intensity = 0
      return
    }
    this.spawnElapsed += dt
    const t = this.spawnElapsed
    const intensity = t < 0.4 ? (t / 0.4) * 9 : Math.max(0, 9 * (1 - (t - 0.4) / 5.5))
    this.spawnLight.intensity = intensity
  }

  // -------------------------------------------------------------------------
  // public API used by React
  // -------------------------------------------------------------------------

  /** BEGIN: freeze-off, walls rise, black lifts, pointer lock, first toll. */
  start() {
    if (this.startedOnce) return
    this.startedOnce = true
    this.introActive = true
    this.introElapsed = 0
    this.spawnElapsed = 0
    this.timeLeft = LOOP_SECONDS
    this.player.enabled = true
    this.store.set({ phase: PHASE.PLAYING, timeLeft: LOOP_SECONDS, fade: 1, prompt: null })
    this.player.requestLock()
    this.audio?.bellToll(0, 220, 0.5)
  }

  /** BEGIN AGAIN: wipe the run and replay loop 1 through the same transition. */
  restart() {
    this.nextLoopNumber = 1
    this.resetElapsed = 0
    this.swapped = false
    this.introActive = false
    this.doorOpened = false
    this.door.wide = false
    this.startedOnce = true
    this.player.enabled = true
    this.timeLeft = LOOP_SECONDS
    this.store.set({ ...restartState(1), phase: PHASE.RESET, fade: 0 })
    this._applyShrineStates() // three candles go dark again
    this._setDoorOpen(false, true)
    this.spawnElapsed = 0
    this.player.requestLock()
    this.audio?.bellSequence(RESET_TIMELINE.tolls, RESET_TIMELINE.tollSpacing)
  }

  /** E / click: light the shrine the player is standing next to. */
  tryLight() {
    if (this.phase !== PHASE.PLAYING || !this.nearestShrine) return false
    return this._lightShrine(this.nearestShrine)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('resize', this._onWindowResize)
    this.canvas.removeEventListener('mousedown', this._onMouseDown)
    this._resizeObserver?.disconnect()
    this.player.dispose()
    const seenTextures = new Set()
    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose()
      const materials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : []
      for (const material of materials) {
        for (const key of ['map', 'bumpMap', 'roughnessMap']) {
          const texture = material[key]
          if (texture && !seenTextures.has(texture)) {
            seenTextures.add(texture)
            texture.dispose()
          }
        }
        material.dispose()
      }
    })
    this.renderer.dispose()
    this.canvas.parentNode?.removeChild(this.canvas)
  }
}
