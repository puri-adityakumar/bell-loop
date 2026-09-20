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

/** Palette (PLAN.md §2). */
export const PALETTE = Object.freeze({
  bg: 0x05060a,
  fog: 0x070a12,
  wall: 0x2a2f3a,
  floor: 0x14171f,
  ceiling: 0x0a0c12,
  wood: 0x4a3320,
  flame: 0xffb347,
  candleLight: 0xff9a3c,
  ivory: 0xe8ddc8,
  brass: 0x8c7a3f,
  cold: 0x445566,
  flashlight: 0xffe6b0,
})

const MAX_WALL_INSTANCES = 400
const FLOOR_SIZE = GRID * CELL_SIZE + 12
const PROMPT_RANGE = 2.4 // metres: an unlit shrine is "in reach"
const INTRO_FADE_SECONDS = 1.4
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

/** Dark stone flagstones with grout lines and speckle. */
function makeFloorTexture(size = 256, tiles = 4, seed = 99) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const noise = valueNoiseField(size, 12, seededRandom(seed))
  const speck = seededRandom(seed + 5)
  const tile = size / tiles
  const image = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x % tile
      const gy = y % tile
      const grout = gx < 2 || gy < 2 ? 0.55 : 1
      const v = (0.55 + noise(x, y) * 0.45) * grout
      const c = Math.max(0, Math.min(255, Math.round(v * 255)))
      const i = (y * size + x) * 4
      image.data[i] = c
      image.data[i + 1] = c
      image.data[i + 2] = Math.min(255, c + 4)
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  // speckle of dust
  ctx.globalAlpha = 0.25
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = speck() > 0.5 ? '#3b4150' : '#0a0c10'
    ctx.fillRect(Math.floor(speck() * size), Math.floor(speck() * size), 1, 1)
  }
  ctx.globalAlpha = 1
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
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
    this.renderer.toneMappingExposure = 1.1
    this.canvas = this.renderer.domElement
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    container.appendChild(this.canvas)

    // --- scene --------------------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(PALETTE.bg)
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, 0.095)
    this.camera = new THREE.PerspectiveCamera(72, this._aspect(), 0.05, 160)

    this.noiseTexture = makeNoiseTexture()
    this.floorTexture = makeFloorTexture()

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
    // a whisper of ambient so unlit faces are not pure black
    this.hemisphere = new THREE.HemisphereLight(0x1a2233, 0x05060a, 0.25)
    this.scene.add(this.hemisphere)

    // the flashlight: a spotlight parented to the camera *position*, whose
    // target lags behind the view direction (that lag is the horror)
    this.flashlight = new THREE.SpotLight(PALETTE.flashlight, 55, 34, 0.46, 0.55, 2)
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
    this.floorTexture.repeat.set(repeat, repeat)
    this.floorTexture.colorSpace = THREE.SRGBColorSpace
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({
        color: PALETTE.floor,
        map: this.floorTexture,
        roughness: 1,
        metalness: 0,
      }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.scene.add(this.floor)

    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({ color: PALETTE.ceiling, roughness: 1, metalness: 0 }),
    )
    this.ceiling.rotation.x = Math.PI / 2
    this.ceiling.position.y = WALL_HEIGHT
    this.scene.add(this.ceiling)
  }

  /**
   * Walls are two InstancedMeshes (one per orientation) of a single box
   * geometry with per-instance colour jitter and a shared noise bump/roughness
   * map, so 240+ wall segments cost two draw calls.
   */
  _buildWalls() {
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.wall,
      roughness: 0.93,
      metalness: 0,
      bumpMap: this.noiseTexture,
      bumpScale: 0.02,
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
      this._wallColor.setRGB(entry.jitter, entry.jitter, entry.jitter)
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
      return {
        axis: wall.axis,
        x: wall.cx,
        y: WALL_HEIGHT / 2,
        z: wall.cz,
        distance,
        jitter: 0.92 + jitterRng() * 0.16,
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

  /** Three squat pedestals with a candle on top, built once and moved per loop. */
  _buildShrines() {
    const woodMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.wood,
      roughness: 0.9,
      metalness: 0.05,
    })
    this.shrines = new Map()
    for (const id of SHRINE_IDS) {
      const group = new THREE.Group()

      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.52, 0.18, 10), woodMaterial)
      base.position.y = 0.09
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.55, 10), woodMaterial)
      shaft.position.y = 0.46
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.3, 0.1, 10), woodMaterial)
      cap.position.y = 0.78
      for (const part of [base, shaft, cap]) {
        part.castShadow = true
        part.receiveShadow = true
      }

      const candleMaterial = new THREE.MeshStandardMaterial({
        color: PALETTE.ivory,
        roughness: 0.72,
      })
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.36, 8), candleMaterial)
      candle.position.y = 1.01
      candle.castShadow = true

      const flameMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.flame })
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), flameMaterial)
      flame.scale.set(0.8, 1.7, 0.8)
      flame.position.y = 1.3

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 10),
        new THREE.MeshBasicMaterial({
          color: PALETTE.flame,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      )
      halo.position.y = 1.3

      const flameLight = new THREE.PointLight(PALETTE.candleLight, 0, 8, 2)
      flameLight.position.y = 1.34

      // a cold glimmer marks an UNLIT shrine: findable in the dark, clearly off
      const glimmer = new THREE.PointLight(PALETTE.cold, 1.2, 2.8, 2)
      glimmer.position.y = 1.15

      group.add(base, shaft, cap, candle, flame, halo, flameLight, glimmer)
      this.scene.add(group)

      this.shrines.set(id, {
        id,
        group,
        candle,
        candleMaterial,
        flame,
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
    this._unlitCandleColor = new THREE.Color(0x6b6b62)
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
      shrine.flame.visible = lit
      shrine.halo.visible = lit
      shrine.flameLight.intensity = lit ? shrine.baseIntensity : 0
      shrine.glimmer.intensity = lit ? 0 : 1.2
      shrine.candleMaterial.color.copy(lit ? this._ivoryColor : this._unlitCandleColor)
    }
  }

  /** Light a shrine for good (the store is the source of truth). */
  _lightShrine(shrine) {
    if (!shrine || shrine.lit) return false
    this.store.update((state) => applyLightCandle(state, shrine.id))
    shrine.lit = true
    shrine.level = 0
    shrine.flame.visible = true
    shrine.halo.visible = true
    shrine.glimmer.intensity = 0
    shrine.candleMaterial.color.copy(this._ivoryColor)
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
   * The chamber at (7,7) has exactly one doorway (maze.centerApproach); its
   * other three edges are ordinary maze walls. The door group is built in a
   * canonical "approach from the north" frame and then yawed into place, so one
   * geometry serves all four approach directions.
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
    const group = new THREE.Group()
    const openingHalf = CELL_SIZE / 2 - WALL_THICKNESS / 2 // 1.33m

    const postGeometry = new THREE.BoxGeometry(0.24, 2.52, 0.42)
    const postLeft = new THREE.Mesh(postGeometry, woodMaterial)
    postLeft.position.set(-openingHalf + 0.12, 1.26, -CELL_SIZE / 2)
    const postRight = new THREE.Mesh(postGeometry, woodMaterial)
    postRight.position.set(openingHalf - 0.12, 1.26, -CELL_SIZE / 2)
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(openingHalf * 2 + 0.3, 0.44, 0.46),
      woodMaterial,
    )
    lintel.position.set(0, 2.72, -CELL_SIZE / 2)
    for (const part of [postLeft, postRight, lintel]) {
      part.castShadow = true
      part.receiveShadow = true
    }

    // hinge group at the left post; the panel swings about it
    const hinge = new THREE.Group()
    hinge.position.set(-openingHalf + 0.16, 0, -CELL_SIZE / 2)
    const panelWidth = (openingHalf - 0.16) * 2
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(panelWidth, 2.44, 0.12),
      woodMaterial,
    )
    panel.position.set(panelWidth / 2, 1.22, 0)
    panel.castShadow = true
    panel.receiveShadow = true
    hinge.add(panel)

    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 6, 14), brassMaterial)
    handle.rotation.y = Math.PI / 2
    handle.position.set(panelWidth - 0.28, 1.16, 0.1)
    hinge.add(handle)

    // what is beyond: a warm plane on the far wall of the chamber, plus a glow
    const beyond = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    )
    beyond.position.set(0, 1.35, CELL_SIZE / 2 - 0.4)
    beyond.rotation.y = Math.PI
    beyond.visible = false

    const doorLight = new THREE.PointLight(0xffb066, 0, 18, 2)
    doorLight.position.set(0, 1.5, 0)
    const hintLight = new THREE.PointLight(0x2a3a55, 1.1, 6.5, 2)
    hintLight.position.set(0, 1.4, -CELL_SIZE / 2 - 0.6)

    group.add(postLeft, postRight, lintel, hinge, beyond, doorLight, hintLight)
    this.scene.add(group)

    this.door = {
      group,
      hinge,
      panel,
      beyond,
      doorLight,
      hintLight,
      swing: 0,
      target: 0,
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
    this.door.target = open ? 1 : 0
    if (instant) {
      this.door.swing = open ? 1 : 0
      this.door.hinge.rotation.y = -1.85 * this.door.swing
    }
    this.door.beyond.visible = open
    this.door.doorLight.visible = open
    this.door.hintLight.visible = !open
    this._refreshColliders()
    if (open && !wasOpen && !instant) {
      this.audio?.doorCreak(1.4)
      this.doorOpened = true
    }
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
      default:
        // START (overlay up, world frozen and sunken) and WON (frozen scene)
        break
    }
    this._updateFlashlight(dt)
    this._updateShrines(dt)
    this._updateDoor(dt)
    this._updateSpawnLight(dt)
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
  }

  _updateShrines(dt) {
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      if (!shrine.lit) continue
      shrine.level += (1 - shrine.level) * (1 - Math.exp(-4 * dt))
      const noise = flickerNoise(this.animTime + shrine.flicker)
      const n01 = 0.5 + 0.5 * noise
      shrine.flameLight.intensity = shrine.baseIntensity * shrine.level * (0.82 + 0.18 * n01)
      shrine.flame.scale.set(0.8 - 0.06 * n01, 1.55 + 0.3 * n01, 0.8 - 0.06 * n01)
      shrine.halo.scale.setScalar(0.9 + 0.25 * n01)
      shrine.halo.material.opacity = 0.1 + 0.06 * n01
    }
  }

  _updateDoor(dt) {
    const door = this.door
    if (Math.abs(door.swing - door.target) > 0.0005) {
      door.swing += (door.target - door.swing) * (1 - Math.exp(-3.2 * dt))
      door.hinge.rotation.y = -1.85 * easeOutCubic01(door.swing)
    }
    if (door.doorLight.visible) {
      door.doorLight.intensity = 15 + Math.sin(this.animTime * 1.7) * 2.5
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
