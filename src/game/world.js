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
  cellKey,
  chebyshev,
  DIRS,
  distanceMap,
  hasWall,
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
   pauseGame,
    resetFade,
    resumeGame,
   restartState,
  shouldDoorOpenAtLoopStart,
  wallRiseDelay,
  wallRiseProgress,
  wallSinkProgress,
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
const DOOR_AJAR_SWING = 0.6
/** Facing into the maze from the (0,0) corner spawn. */
const ENTRANCE_YAW = -Math.PI * 0.5
const REVIEW_STATES = new Set(['entry', 'shrine', 'door', 'reset', 'win'])

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

function segmentIntersectsBox(ax, az, bx, bz, minX, maxX, minZ, maxZ) {
  const dx = bx - ax
  const dz = bz - az
  let near = 0
  let far = 1
  if (Math.abs(dx) < 1e-8) {
    if (ax < minX || ax > maxX) return false
  } else {
    const x1 = (minX - ax) / dx
    const x2 = (maxX - ax) / dx
    near = Math.max(near, Math.min(x1, x2))
    far = Math.min(far, Math.max(x1, x2))
    if (near > far) return false
  }
  if (Math.abs(dz) < 1e-8) {
    if (az < minZ || az > maxZ) return false
  } else {
    const z1 = (minZ - az) / dz
    const z2 = (maxZ - az) / dz
    near = Math.max(near, Math.min(z1, z2))
    far = Math.min(far, Math.max(z1, z2))
    if (near > far) return false
  }
  return true
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
function makeCobbleTexture(size = 512, cells = 6, seed = 99) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  ctx.fillStyle = '#11151b'
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
      ctx.fillStyle = `rgb(${Math.round(45 + 70 * v)},${Math.round(50 + 74 * v)},${Math.round(60 + 80 * v)})`
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, rand() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
      // worn highlight, top-left
      ctx.strokeStyle = `rgba(205,215,225,${0.08 + rand() * 0.1})`
      ctx.lineWidth = Math.max(1.5, cell * 0.06)
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, Math.PI * 1.05, Math.PI * 1.75)
      ctx.stroke()
      // seated shadow, bottom-right
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx * 0.85, ry * 0.85, 0, Math.PI * 0.1, Math.PI * 0.8)
      ctx.stroke()
      ctx.strokeStyle = `rgba(10,12,16,${0.18 + rand() * 0.16})`
      ctx.lineWidth = Math.max(1, cell * 0.025)
      ctx.beginPath()
      ctx.moveTo(cx - rx * 0.35, cy + ry * 0.18)
      ctx.lineTo(cx + rx * (0.1 + rand() * 0.25), cy - ry * 0.22)
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
function makePlankTexture(size = 256, boards = 6, seed = 606) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  const boardH = size / boards
  for (let b = 0; b < boards; b++) {
    const v = 0.42 + rand() * 0.35
    ctx.fillStyle = `rgb(${Math.round(34 * v + 14)},${Math.round(24 * v + 10)},${Math.round(15 * v + 7)})`
    ctx.fillRect(0, b * boardH, size, boardH)
    // grain streaks
    ctx.globalAlpha = 0.25
    for (let s = 0; s < 9; s++) {
      ctx.fillStyle = rand() > 0.5 ? '#0a0705' : '#4a3826'
      ctx.fillRect(0, b * boardH + rand() * boardH, size, 1)
    }
    ctx.globalAlpha = 1
    if (rand() > 0.55) {
      const knotX = rand() * size
      const knotY = b * boardH + boardH * (0.3 + rand() * 0.4)
      ctx.strokeStyle = 'rgba(12,8,5,0.6)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.ellipse(knotX, knotY, boardH * (0.08 + rand() * 0.08), boardH * 0.05, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
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
function makeBrickTexture(size = 512, seed = 4242) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(seed)
  const rows = 8
  const brickH = size / rows
  const brickW = size / 4
  const mortar = 6
  ctx.fillStyle = '#232832' // mortar
  ctx.fillRect(0, 0, size, size)
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * (brickW / 2)
    for (let col = -1; col <= 4; col++) {
      const x = col * brickW + offset
      const y = row * brickH
      // per-brick value: cold grey with occasional warmer stone
      const v = 0.58 + rand() * 0.4
      const warm = rand() < 0.22 ? 12 : 0
      const r = Math.round(42 * v + warm)
      const g = Math.round(48 * v + warm * 0.7)
      const b = Math.round(58 * v)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x + mortar / 2, y + mortar / 2, brickW - mortar, brickH - mortar)
      // chipped highlight on one edge, shadow on the other
      ctx.fillStyle = `rgba(255,255,255,${0.03 + rand() * 0.05})`
      ctx.fillRect(x + mortar / 2, y + mortar / 2, brickW - mortar, 2)
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      ctx.fillRect(x + mortar / 2, y + brickH - mortar / 2 - 2, brickW - mortar, 2)
      if (rand() > 0.72) {
        ctx.fillStyle = 'rgba(10,12,16,0.38)'
        const chipW = brickW * (0.08 + rand() * 0.12)
        ctx.fillRect(x + brickW * (0.12 + rand() * 0.55), y + 2, chipW, 3 + rand() * 4)
      }
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

function makeEmberSpriteTexture(size = 32) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.3, 'rgba(255,226,150,0.95)')
  gradient.addColorStop(0.7, 'rgba(255,130,40,0.55)')
  gradient.addColorStop(1, 'rgba(255,80,10,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Soft teardrop glow used by the layered flame sprites (loop 7). */
function makeFlameSpriteTexture(size = 64, variant = 0) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rand = seededRandom(0xf1a6e + variant * 977)
  const lean = (rand() - 0.5) * size * 0.1
  const centerX = size * 0.5 + lean
  const baseY = size * (0.66 + rand() * 0.04)
  const outer = ctx.createRadialGradient(centerX, baseY, 1, centerX, baseY, size * 0.56)
  outer.addColorStop(0, 'rgba(255,244,214,0.96)')
  outer.addColorStop(0.28, 'rgba(255,180,80,0.82)')
  outer.addColorStop(0.66, 'rgba(190,64,16,0.24)')
  outer.addColorStop(1, 'rgba(80,16,0,0)')
  ctx.fillStyle = outer
  ctx.beginPath()
  ctx.ellipse(centerX, baseY - size * 0.02, size * (0.25 + rand() * 0.035), size * (0.4 + rand() * 0.05), lean / size, 0, Math.PI * 2)
  ctx.fill()
  ctx.save()
  ctx.translate(centerX, baseY)
  ctx.rotate(lean / size)
  ctx.globalCompositeOperation = 'lighter'
  const body = ctx.createRadialGradient(0, -size * 0.06, 1, 0, -size * 0.06, size * 0.36)
  body.addColorStop(0, 'rgba(255,250,222,0.98)')
  body.addColorStop(0.32, 'rgba(255,195,88,0.9)')
  body.addColorStop(0.76, 'rgba(226,91,20,0.34)')
  body.addColorStop(1, 'rgba(120,24,0,0)')
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.ellipse(0, -size * 0.05, size * 0.16, size * 0.31, 0, 0, Math.PI * 2)
  ctx.fill()
  const core = ctx.createRadialGradient(0, size * 0.04, 0.5, 0, size * 0.04, size * 0.18)
  core.addColorStop(0, 'rgba(255,255,244,1)')
  core.addColorStop(0.4, 'rgba(255,226,146,0.9)')
  core.addColorStop(1, 'rgba(255,126,34,0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.ellipse(0, size * 0.05, size * 0.08, size * 0.14, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.globalCompositeOperation = 'source-over'
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * loop 15: procedural engraved-glyph decals — angular scratched strokes, no
 * lettering anywhere. Three variants are generated once and shared across the
 * six wall engravings; per-placement seeds vary height, tilt and which wall.
 */
function makeGlyphTexture(seed) {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const rng = mulberry32(seed)

  // one random angular scratch: square-cornered turns with occasional diagonals
  const scratchPoints = () => {
    const points = [[0, 0]]
    let x = 0
    let y = 0
    const segments = 2 + Math.floor(rng() * 4)
    for (let i = 0; i < segments; i++) {
      const step = 14 + rng() * 26
      const angle = (Math.floor(rng() * 4) * Math.PI) / 2 + (rng() < 0.3 ? Math.PI / 4 : 0)
      x += Math.cos(angle) * step
      y += Math.sin(angle) * step
      points.push([x, y])
    }
    return points
  }
  const strokePts = (points, dx, dy, color, width) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'square'
    ctx.beginPath()
    points.forEach(([px, py], i) => {
      if (i === 0) ctx.moveTo(px + dx, py + dy)
      else ctx.lineTo(px + dx, py + dy)
    })
    ctx.stroke()
  }

  const glyphs = 2 + Math.floor(rng() * 2)
  for (let g = 0; g < glyphs; g++) {
    ctx.save()
    ctx.translate(40 + rng() * 150, 40 + rng() * 150)
    ctx.rotate((rng() - 0.5) * 0.9)
    const points = scratchPoints()
    // shadow pass first, then the lit scratch on top: reads as carved-in stone
    strokePts(points, 2.5, 3.5, 'rgba(0,0,0,0.6)', 7)
    strokePts(points, 0, 0, 'rgba(216,206,178,0.92)', 4.5)
    // a closing mark: scratch circle or chevron at the end of the walk
    const end = points[points.length - 1]
    const roll = rng()
    if (roll < 0.4) {
      ctx.strokeStyle = 'rgba(216,206,178,0.92)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(end[0] + 8, end[1] - 6, 5 + rng() * 4, 0, Math.PI * 2)
      ctx.stroke()
    } else if (roll < 0.7) {
      ctx.strokeStyle = 'rgba(216,206,178,0.92)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(end[0], end[1])
      ctx.lineTo(end[0] + 12, end[1] - 12)
      ctx.lineTo(end[0] + 24, end[1])
      ctx.stroke()
    }
    ctx.restore()
  }
  // grime pits so the decal never reads as a clean sticker
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  for (let i = 0; i < 40; i++) {
    ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 3, 1 + rng() * 3)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * loop 15: a smeared handprint decal — palm blob, five fanned fingers, a low
 * thumb — then speckle-eroded so only patches survive on the stone.
 */
function makeHandprintTexture(seed) {
  const w = 128
  const h = 160
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const rng = mulberry32(seed)
  ctx.fillStyle = 'rgba(255,255,255,0.95)'

  const blob = (x, y, rx, ry, rot = 0) => {
    ctx.beginPath()
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2)
    ctx.fill()
  }
  blob(64, 104, 30, 34) // palm
  for (let i = 0; i < 4; i++) {
    const angle = -0.34 + i * 0.22
    const fx = 64 + Math.sin(angle) * 34
    const fy = 66 - Math.cos(angle) * 18 - rng() * 6
    blob(fx, fy, 7.5, 20 + rng() * 7, -angle * 0.8)
  }
  blob(30, 96, 9, 22, 1.05) // thumb, low and to the side
  // erosion: punch speckle holes so it reads as a partial print, not a stamp
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 260; i++) {
    ctx.beginPath()
    ctx.arc(rng() * w, rng() * h, 1 + rng() * 2.6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
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
    this.resumePending = false
    this.resumeRequestId = null
    this.resumeFallbackTimer = null
    this.activeLockRequest = null

    // --- renderer -----------------------------------------------------------
    this.renderer = options.createRenderer
      ? options.createRenderer(container)
      : new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
    this.renderer.setSize(container.clientWidth || 800, container.clientHeight || 450, false)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    // loop 1: colder cellar dread — darker exposure, desaturated via ACES film
    this.renderer.toneMappingExposure = 1.05
    this.canvas = this.renderer.domElement
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.tabIndex = 0
    this.canvas.setAttribute?.('aria-label', 'Bell Loop 3D game view')
    container.appendChild(this.canvas)

    // --- scene --------------------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(PALETTE.bg)
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, 0.1)
    this.camera = new THREE.PerspectiveCamera(72, this._aspect(), 0.05, 160)

    this.noiseTexture = makeNoiseTexture()
    this.cobbleTexture = makeCobbleTexture(512, 10, 99)
    this.plankTexture = makePlankTexture()
    this.brickTexture = makeBrickTexture()
    this.flameSpriteTextures = [0, 1, 2].map((variant) => makeFlameSpriteTexture(64, variant))
    this.flameSpriteTexture = this.flameSpriteTextures[0]
    this.emberSpriteTexture = makeEmberSpriteTexture()
    const maxAnisotropy = this.renderer.capabilities?.getMaxAnisotropy?.() ?? 1
    for (const texture of [
      this.noiseTexture,
      this.cobbleTexture,
      this.plankTexture,
      this.brickTexture,
      ...this.flameSpriteTextures,
      this.emberSpriteTexture,
    ]) {
      texture.anisotropy = Math.min(4, maxAnisotropy)
    }
    this.noiseTexture.repeat.set(2.4, 2.4)

    this._buildLights()
    this._buildStaticGeometry()
    this._buildWalls()
    this._buildShrines()
    this._buildDoor()
    this._buildMicroStory() // loop 15: engravings, handprint, toy boat

    // --- player -------------------------------------------------------------
    this.player = new PlayerController(this.camera, this.canvas, {
      onFootstep: (sprinting) => this.audio?.footstep(sprinting),
      onLockChange: (locked, wasLocked, requestId) => this._handlePointerLock(locked, wasLocked, requestId),
      onLockError: (requestId) => this._handlePointerLockError(requestId),
    })
    this.player.attach()
    this.player.enabled = false
    this._motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    this.reducedMotion = this._motionQuery?.matches ?? false
    this.player.reducedMotion = this.reducedMotion
    this._onMotionPreference = (event) => {
      this.reducedMotion = event.matches
      this.player.reducedMotion = event.matches
      if (event.matches) this.shake = 0
    }
    if (this._motionQuery?.addEventListener) this._motionQuery.addEventListener('change', this._onMotionPreference)
    else this._motionQuery?.addListener?.(this._onMotionPreference)

    // --- runtime state ------------------------------------------------------
    this.phase = this.store.get().phase
    this.resetElapsed = 0
    this.swapped = false
    this.nextLoopNumber = 1
    this.introElapsed = 0
    this.introActive = false
    this.startedOnce = false
    this.animTime = 0
    // loop 11: cinematic screenshake — amplitude decays, applied as a temporary
    // camera offset after the player writes its pose each frame
    this.shake = 0 // current shake amplitude (world units)
    this._shakeSeed = Math.random() * 100
    // loop 11: wall animation — during RESET walls travel between layouts over
    // time instead of popping at the swap
    this.wallAnimFrom = null // map "axis:x|z" -> { x, z, y } old positions
    this.wallAnimT = 0 // 0..1 progress of the cross-fade
    this.nearestShrine = null
    this.doorOpened = false
    this.ignorePointerUnlock = false
    this.maze = null
    this.wallEntries = []
    this.meterAccum = 0
    // loop 14: rolling FPS meter (sampled twice a second, hidden unless F)
    this._fpsFrames = 0
    this._fpsAccum = 0
    this.renderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0 }
    this.audioTensionStage = 0
    /** Authoritative countdown; mirror into the store at ~20Hz. */
    this.timeLeft = LOOP_SECONDS
    this.timer = new THREE.Timer()
    this.timer.connect(document)

    // --- input --------------------------------------------------------------
    this._onKeyDown = (e) => {
      if (e.code === 'KeyP' || (e.code === 'Escape' && !this.player.locked)) {
        this._pause('keyboard')
        return
      }
      if (this.store.get().phase === PHASE.PAUSED) return
      if (e.code === 'KeyE' || e.code === 'Space') this.tryLight()
      if (e.code === 'KeyF' && !e.repeat) {
        this.store.update((state) => ({ ...state, showFps: !state.showFps }))
      }
    }
    this._onMouseDown = () => {
      const phase = this.store.get().phase
      if (phase === PHASE.PAUSED) {
        this.resume()
        return
      }
      this.tryLight()
      if (this.startedOnce && phase !== PHASE.WON && !this.player.locked) {
        this._requestPlayerLock()
      }
    }
    window.addEventListener('keydown', this._onKeyDown)
    this.canvas.addEventListener('mousedown', this._onMouseDown)

    this._onWindowBlur = () => this._pauseForFocus()
    this._onVisibilityChange = () => {
      if (document.hidden) this._pauseForFocus()
    }
    window.addEventListener('blur', this._onWindowBlur)
    document.addEventListener('visibilitychange', this._onVisibilityChange)

    this._onWindowResize = () => this.resize()
    window.addEventListener('resize', this._onWindowResize)
    this._resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize())
    this._resizeObserver?.observe(container)

    // --- first layout; walls stay sunk in the floor until BEGIN -------------
    this._loadMaze(1, { doorOpen: false })
    this._updateWallMatrices(() => 1)
    this.store.set({ fade: 0 })

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
    this.hemisphere = new THREE.HemisphereLight(0x1b2638, 0x05070c, 0.42)
    this.scene.add(this.hemisphere)

    // the flashlight (loop 6): a warm lamp cone with a soft penumbra edge. It
    // is the scene's ONLY shadow-casting light — candle points stay shadow-free
    // for speed — and its target lags behind the view direction (that lag is
    // the horror).
    this.flashlight = new THREE.SpotLight(0xffdca0, 14, 28, 0.5, 0.72, 1.2)
    this.flashlight.castShadow = true
    this.flashlight.shadow.mapSize.set(1024, 1024)
    this.flashlight.shadow.camera.near = 0.2
    this.flashlight.shadow.camera.far = 28
    this.flashlight.shadow.bias = -0.0008
    this.flashlight.shadow.normalBias = 0.02
    this.flashlight.shadow.radius = 0.6
    this.flashlightWarm = new THREE.Color(0xffdca0)
    this.flashlightDim = new THREE.Color(0x5b321e)
    this.flashlightTarget = new THREE.Object3D()
    this.flashlight.target = this.flashlightTarget
    this.scene.add(this.flashlight)
    this.scene.add(this.flashlightTarget)
    this.flashlightFill = new THREE.PointLight(0xffc98a, 0.7, 4.2, 2)
    this.flashlightFill.castShadow = false
    this.scene.add(this.flashlightFill)

    // a faint warm lamp at the entrance so every reset has an anchor point
    this.spawnLight = new THREE.PointLight(0xffd9a0, 0, 6, 2)
    this.scene.add(this.spawnLight)
  }

  _buildStaticGeometry() {
    const repeat = FLOOR_SIZE / 4
    this.cobbleTexture.repeat.set(repeat, repeat)
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0x7d8793,
        map: this.cobbleTexture,
        bumpMap: this.cobbleTexture,
        bumpScale: 0.08,
        roughness: 0.96,
        metalness: 0,
      }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.scene.add(this.floor)

    // ceiling: dark planks
    const plankRepeat = FLOOR_SIZE / 4
    this.plankTexture.repeat.set(plankRepeat, plankRepeat)
    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({
        color: 0x69737e,
        map: this.plankTexture,
        bumpMap: this.noiseTexture,
        bumpScale: 0.04,
        roughness: 0.98,
        metalness: 0,
      }),
    )
    this.ceiling.rotation.x = Math.PI / 2
    this.ceiling.position.y = WALL_HEIGHT
    this.scene.add(this.ceiling)

    // --- loop 5: dark wooden ceiling beams every few cells ------------------
    const beamMaterial = new THREE.MeshStandardMaterial({
      color: 0x302116,
      roughness: 0.9,
      metalness: 0.04,
      bumpMap: this.noiseTexture,
      bumpScale: 0.035,
    })
    const span = GRID * CELL_SIZE
    const beamStep = CELL_SIZE * 3
    const beamY = WALL_HEIGHT - 0.09
    const beamPositions = []
    for (let k = -2; k <= 2; k++) beamPositions.push(k * beamStep)
    const longBeamGeometry = new THREE.BoxGeometry(span + 6, 0.16, 0.26)
    const crossBeamGeometry = new THREE.BoxGeometry(0.26, 0.16, span + 6)
    const beamMatrix = new THREE.Matrix4()
    const beamX = new THREE.InstancedMesh(longBeamGeometry, beamMaterial, beamPositions.length)
    const beamZ = new THREE.InstancedMesh(crossBeamGeometry, beamMaterial, beamPositions.length)
    beamPositions.forEach((position, index) => {
      beamMatrix.makeTranslation(0, beamY, position)
      beamX.setMatrixAt(index, beamMatrix)
      beamMatrix.makeTranslation(position, beamY, 0)
      beamZ.setMatrixAt(index, beamMatrix)
    })
    for (const beam of [beamX, beamZ]) {
      beam.instanceMatrix.needsUpdate = true
      beam.castShadow = true
      beam.receiveShadow = true
      beam.frustumCulled = false
      this.scene.add(beam)
    }
    this.beamX = beamX
    this.beamZ = beamZ

    // --- occasional hanging chains (curved tube segments) --------------------
    const chainMaterial = new THREE.MeshStandardMaterial({
      color: 0x353a42,
      roughness: 0.68,
      metalness: 0.58,
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

    const dustCount = 72
    const dustPositions = new Float32Array(dustCount * 3)
    const dustSeeds = new Float32Array(dustCount * 6)
    const dustRng = mulberry32(0xd057)
    for (let i = 0; i < dustCount; i++) {
      const seed = i * 6
      const position = i * 3
      const x = (dustRng() - 0.5) * span
      const y = 0.25 + dustRng() * (WALL_HEIGHT - 0.5)
      const z = (dustRng() - 0.5) * span
      dustSeeds[seed] = x
      dustSeeds[seed + 1] = y
      dustSeeds[seed + 2] = z
      dustSeeds[seed + 3] = dustRng()
      dustSeeds[seed + 4] = 0.25 + dustRng() * 0.8
      dustSeeds[seed + 5] = 0.12 + dustRng() * 0.32
      dustPositions[position] = x
      dustPositions[position + 1] = y
      dustPositions[position + 2] = z
    }
    const dustGeometry = new THREE.BufferGeometry()
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    this.dust = new THREE.Points(
      dustGeometry,
      new THREE.PointsMaterial({
        color: 0x87909a,
        size: 0.018,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    )
    this.dust.frustumCulled = false
    this.dustSeeds = dustSeeds
    this.scene.add(this.dust)
  }

  /**
   * Walls are one InstancedMesh of a single box geometry with per-instance
   * colour jitter, orientation, and a shared noise bump/roughness map.
   */
  _buildWalls() {
    this.brickTexture.repeat.set(2.5, 2)
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x818c99,
      // loop 4: real stone-brick surface — the map carries the brick pattern,
      // the same tile doubles as bumpMap so mortar lines recess
      map: this.brickTexture,
      roughness: 0.95,
      metalness: 0,
      bumpMap: this.brickTexture,
      bumpScale: 0.06,
    })
    this.wallMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CELL_SIZE + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS),
      this.wallMaterial,
      MAX_WALL_INSTANCES,
    )
    this.wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.wallMesh.castShadow = true
    this.wallMesh.receiveShadow = true
    this.wallMesh.frustumCulled = false
    this.wallMesh.count = 0
    this.scene.add(this.wallMesh)
    this._wallMatrix = new THREE.Matrix4()
    this._wallOffset = new THREE.Vector3()
    this._wallQuat = new THREE.Quaternion()
    this._wallUp = new THREE.Vector3(0, 1, 0)
    this._wallScale = new THREE.Vector3(1, 1, 1)
    this._wallColor = new THREE.Color()
  }

  /**
   * Write every wall instance, offsetting each one's Y by its rise progress:
   * 0 = sunk below the floor, 1 = standing.
   * @param {(entry: object) => number} progressFor
   */
  _updateWallMatrices(progressFor) {
    const slide = this.wallAnimFrom ? easeInOut01(this.wallAnimT) : 1
    let index = 0
    for (const entry of this.wallEntries) {
      let p = progressFor(entry)
      if (p < 0) p = 0
      else if (p > 1) p = 1
      let x = entry.x
      let z = entry.z
      if (slide < 1 && entry.fromX !== undefined) {
        x = entry.fromX + (entry.x - entry.fromX) * slide
        z = entry.fromZ + (entry.z - entry.fromZ) * slide
      }
      const y = entry.y - (1 - p) * (WALL_HEIGHT + 0.5)
      this._wallOffset.set(x, y, z)
      this._wallQuat.setFromAxisAngle(this._wallUp, entry.axis === 'z' ? Math.PI / 2 : 0)
      this._wallMatrix.compose(this._wallOffset, this._wallQuat, this._wallScale)
      this.wallMesh.setMatrixAt(index, this._wallMatrix)
      this._wallColor.setRGB(entry.tintR, entry.tintG, entry.tintB)
      this.wallMesh.setColorAt(index, this._wallColor)
      index += 1
    }
    this.wallMesh.count = index
    this.wallMesh.instanceMatrix.needsUpdate = true
    if (this.wallMesh.instanceColor) this.wallMesh.instanceColor.needsUpdate = true
  }

  /** loop 11: snapshot the standing walls so the next layout can glide in. */
  _captureWallPositions() {
    this.wallAnimFrom = this.wallEntries
      .filter((entry) => entry.y > 0)
      .map((entry) => ({ axis: entry.axis, x: entry.x, z: entry.z }))
  }

  _pairWallAnimations() {
    if (!this.wallAnimFrom) return
    const available = this.wallAnimFrom.slice()
    const maxDistance = CELL_SIZE * 2.4
    for (const entry of this.wallEntries) {
      let bestIndex = -1
      let bestDistance = maxDistance
      for (let i = 0; i < available.length; i++) {
        const candidate = available[i]
        if (candidate.axis !== entry.axis) continue
        const distance = Math.hypot(candidate.x - entry.x, candidate.z - entry.z)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
        }
      }
      if (bestIndex >= 0) {
        const from = available.splice(bestIndex, 1)[0]
        entry.fromX = from.x
        entry.fromZ = from.z
      }
    }
  }

  /**
   * Build a loop's layout: maze graph, wall instances (with per-wall rise
   * delays), the player's colliders + spawn, the three shrines and the door.
   */
  _loadMaze(loopNumber, { doorOpen = false, doorInstant = true } = {}) {
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
    this.spawnLight.position.set(entrance.x, 0.9, entrance.z)
    this.spawnElapsed = 0

    this._repositionShrines(maze)
    this._positionDoor(maze)
    this._positionMicroStory(maze)
    this._setDoorOpen(doorOpen, doorInstant)
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
      color: 0x69737f,
      roughness: 0.97,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.05,
    })
    const stoneDark = new THREE.MeshStandardMaterial({
      color: 0x505a66,
      roughness: 0.98,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.06,
    })
    const ironMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b3037,
      roughness: 0.78,
      metalness: 0.42,
      bumpMap: this.noiseTexture,
      bumpScale: 0.018,
    })
    this.shrines = new Map()
    const dripRng = mulberry32(0xbea2) // one stream, so the three shrines differ
    for (const id of SHRINE_IDS) {
      const group = new THREE.Group()
      const variant = 0.94 + dripRng() * 0.12

      // beveled square plinth (a low-sided frustum rotated 45° reads as chamfered)
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4 * variant, 0.47 * variant, 0.16, 8), stoneDark)
      base.position.y = 0.08
      base.rotation.y = Math.PI / 4

      // turned column with a waist and a subtle shoulder
      const columnProfile = [
        new THREE.Vector2(0.2 * variant, 0.16),
        new THREE.Vector2(0.18 * variant, 0.23),
        new THREE.Vector2(0.16 * variant, 0.48),
        new THREE.Vector2(0.19 * variant, 0.72),
        new THREE.Vector2(0.2 * variant, 0.78),
      ]
      const column = new THREE.Mesh(new THREE.LatheGeometry(columnProfile, 10), stoneMaterial)
      column.rotation.y = dripRng() * Math.PI
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.19 * variant, 0.19 * variant, 0.05, 10), stoneDark)
      collar.position.y = 0.72

      // chipped cap: irregular 9-gon slab, uneven rim
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.27 * variant, 0.2 * variant, 0.1, 9), stoneMaterial)
      cap.position.y = 0.83
      cap.rotation.y = dripRng() * Math.PI
      cap.scale.set(1 + dripRng() * 0.06, 1, 1 - dripRng() * 0.04)
      for (const part of [base, column, collar, cap]) {
        part.castShadow = true
        part.receiveShadow = true
      }

      // iron holder ring + drip dish on the cap
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 16), ironMaterial)
      dish.position.y = 0.9
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 8, 20), ironMaterial)
      ring.rotation.x = Math.PI / 2
      ring.position.y = 0.935
      dish.castShadow = true

      // the candle: wax stub with drips frozen down its side
      const candleMaterial = new THREE.MeshStandardMaterial({
        color: PALETTE.ivory,
        roughness: 0.62,
      })
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.34, 12), candleMaterial)
      candle.position.y = 1.05
      candle.castShadow = true
      const dripCount = 3 + Math.floor(dripRng() * 3)
      const drips = []
      for (let i = 0; i < dripCount; i++) {
        const h = 0.07 + dripRng() * 0.13
        const angle = dripRng() * Math.PI * 2
        const r = 0.082
        const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.026, h, 6), candleMaterial)
        drip.position.set(Math.cos(angle) * r, 1.12 - h / 2, Math.sin(angle) * r)
        const blob = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 5), candleMaterial)
        blob.position.set(Math.cos(angle) * r, 1.12 - h, Math.sin(angle) * r)
        blob.scale.set(1, 0.55, 1)
        drips.push(drip, blob)
      }

      // layered sprite flame (loop 7): three additive teardrops that wobble at
      // different frequencies, replacing the old stretched sphere
      const flames = [0, 1, 2].map((layer) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.flameSpriteTextures[layer],
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
        new THREE.SphereGeometry(0.12, 10, 10),
        new THREE.MeshBasicMaterial({
          color: PALETTE.flame,
          transparent: true,
          opacity: 0.04,
          depthWrite: false,
        }),
      )
      halo.position.y = 1.34

      const EMBER_COUNT = 16
      const emberPositions = new Float32Array(EMBER_COUNT * 3)
      const emberSeeds = new Float32Array(EMBER_COUNT * 5)
      const emberColors = new Float32Array(EMBER_COUNT * 3)
      for (let i = 0; i < EMBER_COUNT; i++) {
        const seed = i * 5
        emberSeeds[seed] = (dripRng() - 0.5) * 0.06
        emberSeeds[seed + 1] = (dripRng() - 0.5) * 0.06
        emberSeeds[seed + 2] = 0.16 + dripRng() * 0.24
        emberSeeds[seed + 3] = dripRng()
        emberSeeds[seed + 4] = 1.1 + dripRng() * 1.8
        const position = i * 3
        emberPositions[position] = emberSeeds[seed]
        emberPositions[position + 1] = 1.2 + emberSeeds[seed + 3] * 0.75
        emberPositions[position + 2] = emberSeeds[seed + 1]
        const heat = 0.55 + dripRng() * 0.45
        emberColors[position] = 1
        emberColors[position + 1] = 0.28 + heat * 0.42
        emberColors[position + 2] = 0.08 + heat * 0.16
      }
      const emberGeometry = new THREE.BufferGeometry()
      emberGeometry.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3))
      emberGeometry.setAttribute('color', new THREE.BufferAttribute(emberColors, 3))
      const embers = new THREE.Points(
        emberGeometry,
        new THREE.PointsMaterial({
          map: this.emberSpriteTexture,
          color: 0xff9a42,
          size: 0.028,
           transparent: true,
           alphaTest: 0.01,
           opacity: 0.62,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
          vertexColors: true,
        }),
      )
      embers.visible = false
      embers.frustumCulled = false

      const flameLight = new THREE.PointLight(PALETTE.candleLight, 0, 5.2, 2)
      flameLight.position.y = 1.4

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
        emberSeeds,
        halo,
        flameLight,
        glimmer,
        cell: null,
        lit: false,
        level: 0, // ramps 0 -> 1 while the candle ignites
        flicker: (id.charCodeAt(0) - 64) * 3.7,
        baseIntensity: 8,
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
      shrine.halo.visible = false
      shrine.flameLight.visible = lit
      shrine.flameLight.intensity = lit ? shrine.baseIntensity : 0
      shrine.flameLight.distance = lit ? 5.2 : 0
      shrine.glimmer.visible = !lit
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
    shrine.halo.visible = false
    shrine.flameLight.visible = true
    shrine.glimmer.visible = false
    shrine.glimmer.intensity = 0
    shrine.candleMaterial.color.copy(this._ivoryColor)
    shrine.candleMaterial.roughness = 0.62
    this.audio?.candleWhoosh()
    this._vibrate(12) // loop 15: a candle catching, felt in the controller
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
    const doorWoodTexture = this.plankTexture.clone()
    doorWoodTexture.needsUpdate = true
    doorWoodTexture.repeat.set(1.2, 2.2)
    const woodMaterial = new THREE.MeshStandardMaterial({
      map: doorWoodTexture,
      color: 0xb08050,
      roughness: 0.9,
      metalness: 0.04,
      bumpMap: this.noiseTexture,
      bumpScale: 0.035,
    })
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: 0x8f783d,
      roughness: 0.52,
      metalness: 0.62,
    })
    const ironMaterial = new THREE.MeshStandardMaterial({
      color: 0x30353d,
      roughness: 0.78,
      metalness: 0.42,
      bumpMap: this.noiseTexture,
      bumpScale: 0.018,
    })
    const stoneMaterial = new THREE.MeshStandardMaterial({
      color: 0x69747f,
      roughness: 0.96,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.06,
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
    const threshold = new THREE.Mesh(new THREE.BoxGeometry(openingHalf * 2.05, 0.08, 0.64), stoneMaterial)
    threshold.position.set(0, 0.04, frameZ)
    threshold.castShadow = true
    threshold.receiveShadow = true
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
    for (const part of [jambLeft, jambRight, threshold, ...voussoirs]) {
      part.castShadow = true
      part.receiveShadow = true
    }

    // --- iron-banded double door --------------------------------------------
    const hingeL = new THREE.Group()
    hingeL.position.set(-openingHalf + 0.14, 0, frameZ)
    const hingeR = new THREE.Group()
    hingeR.position.set(openingHalf - 0.14, 0, frameZ)
    const panelWidth = openingHalf - 0.14
    const boardWidth = panelWidth / 4
    const boardGeometry = new THREE.BoxGeometry(boardWidth * 0.985, 2.34, 0.1)
    const panelL = new THREE.Group()
    const panelR = new THREE.Group()
    const backingL = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, 2.34, 0.06), woodMaterial)
    const backingR = new THREE.Mesh(new THREE.BoxGeometry(panelWidth, 2.34, 0.06), woodMaterial)
    backingL.position.set(0, 1.17, -0.035)
    backingR.position.set(0, 1.17, -0.035)
    panelL.add(backingL)
    panelR.add(backingR)
    for (let board = 0; board < 4; board++) {
      const offset = -panelWidth / 2 + boardWidth * (board + 0.5)
      const leftBoard = new THREE.Mesh(boardGeometry, woodMaterial)
      leftBoard.position.set(offset, 1.17, 0)
      const rightBoard = new THREE.Mesh(boardGeometry, woodMaterial)
      rightBoard.position.set(-offset, 1.17, 0)
      panelL.add(leftBoard)
      panelR.add(rightBoard)
    }
    for (const board of [...panelL.children, ...panelR.children]) {
      board.castShadow = true
      board.receiveShadow = true
    }
    // iron straps, rivets, and a ring handle
    for (const hinge of [hingeL, hingeR]) {
      const sign = hinge === hingeL ? 1 : -1
      for (const bandY of [0.52, 1.78]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(panelWidth * 0.94, 0.09, 0.035), ironMaterial)
        band.position.set(sign * (panelWidth / 2), bandY, 0.07)
        hinge.add(band)
        for (const rivetX of [-panelWidth * 0.34, panelWidth * 0.34]) {
          const rivet = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.045, 8), brassMaterial)
          rivet.rotation.x = Math.PI / 2
          rivet.position.set(sign * (panelWidth / 2 + rivetX), bandY, 0.095)
          hinge.add(rivet)
        }
      }
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 8, 18), brassMaterial)
      handle.position.set(sign * (panelWidth - 0.22), 1.12, 0.09)
      hinge.add(handle)
    }
    panelL.position.x = panelWidth / 2
    panelR.position.x = -panelWidth / 2
    hingeL.add(panelL)
    hingeR.add(panelR)

    // what is beyond: a warm plane on the far wall of the chamber, plus a glow
    const beyond = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x8f6a4a, roughness: 1, metalness: 0 }),
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
    const leakLight = new THREE.PointLight(0xffb066, 0, 3.8, 2)
    leakLight.position.set(0, 1.3, frameZ - 0.35)
    leakLight.visible = false

    const doorLight = new THREE.PointLight(0xffb066, 0, 7, 2)
    doorLight.position.set(0, 1.5, 0)
    doorLight.visible = false
    const hintLight = new THREE.PointLight(0x2a3a55, 1.1, 4.5, 2)
    hintLight.position.set(0, 1.4, -CELL_SIZE / 2 - 0.6)

    group.add(jambLeft, jambRight, threshold, ...voussoirs, hingeL, hingeR, beyond, leak, leakLight, doorLight, hintLight)
    this.scene.add(group)

    this.door = {
      group,
       hingeL,
       hingeR,
       panelL,
       panelR,
       backingL,
       backingR,
       panelWidth,
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

  // -------------------------------------------------------------------------
  // micro-story set dressing (loop 15): engravings, a handprint, a toy boat
  // -------------------------------------------------------------------------

  /**
   * loop 15: pure set dressing, no text anywhere — six scratched glyphs on
   * walls the loop pattern makes you retrace (three on the canonical
   * entrance-to-centre route, one beside each shrine), a barely-visible
   * handprint on the stone beside the door, and a discarded toy boat in a
   * dead-end corner. Built once; positioned per layout like the shrines and
   * re-dressed during the reset's full-black hold.
   */
  _buildMicroStory() {
    this.microGroup = new THREE.Group()
    this.scene.add(this.microGroup)

    // three shared glyph variants; placement seeds vary height, tilt and wall
    this.glyphTextures = [
      makeGlyphTexture(0x61c4),
      makeGlyphTexture(0x2b9e),
      makeGlyphTexture(0x9d51),
    ]
    this.engravings = []
    for (let i = 0; i < 6; i++) {
      const material = new THREE.MeshStandardMaterial({
        map: this.glyphTextures[i % 3],
        color: 0xb9b09a,
        transparent: true,
        opacity: 0.5,
        roughness: 1,
        metalness: 0,
        depthWrite: false, // a scratch decal, not geometry
      })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.58), material)
      plane.renderOrder = 2
      plane.visible = false
      this.microGroup.add(plane)
      this.engravings.push(plane)
    }

    const debrisGeometry = new THREE.DodecahedronGeometry(0.11, 0)
    const debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0x343a42,
      roughness: 0.98,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.025,
    })
    this.debrisCapacity = 12
    this.debris = new THREE.InstancedMesh(debrisGeometry, debrisMaterial, this.debrisCapacity)
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.debris.castShadow = false
    this.debris.receiveShadow = true
    this.debris.frustumCulled = false
    this.debris.count = 0
    this._debrisMatrix = new THREE.Matrix4()
    this._debrisPosition = new THREE.Vector3()
    this._debrisScale = new THREE.Vector3()
    this._debrisQuaternion = new THREE.Quaternion()
    this._debrisEuler = new THREE.Euler()
    this._debrisColor = new THREE.Color()
    this.microGroup.add(this.debris)

    this._buildHandprint()
    this._buildBoat()
  }

  /** The handprint rides the door group so it tracks the approach yaw. */
  _buildHandprint() {
    this.handprintTexture = makeHandprintTexture(0x41f2)
    const material = new THREE.MeshStandardMaterial({
      map: this.handprintTexture,
      color: 0x4d2a22, // old blood gone brown in the stone
      transparent: true,
      opacity: 0.24,
      roughness: 1,
      metalness: 0,
      depthWrite: false,
    })
    const openingHalf = CELL_SIZE / 2 - WALL_THICKNESS / 2
    const frameZ = -CELL_SIZE / 2
    const handprint = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.42), material)
    // on the approach-side jamb face, proud of the stone, facing the corridor
    handprint.position.set(-(openingHalf + 0.02), 1.34, frameZ - 0.278)
    handprint.rotation.y = Math.PI
    handprint.rotation.z = 0.14 // someone pressed it and slipped
    handprint.renderOrder = 2
    this.door.group.add(handprint)
    this.handprint = handprint
  }

  /** A small weathered toy boat, snapped mast and all, lying where it fell. */
  _buildBoat() {
    const weathered = new THREE.MeshStandardMaterial({
      color: 0x6f6350,
      roughness: 0.94,
      metalness: 0.02,
      bumpMap: this.noiseTexture,
      bumpScale: 0.02,
    })
    const boat = new THREE.Group()
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, 16),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = -0.001
    shadow.scale.set(1.2, 0.62, 1)
    boat.add(shadow)
    this.boatShadow = shadow
    const keel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.2), weathered)
    keel.position.y = 0.025
    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.2), weathered)
    sideL.position.set(0, 0.1, -0.082)
    sideL.rotation.x = 0.62
    const sideR = sideL.clone()
    sideR.position.z = 0.082
    sideR.rotation.x = -0.62
    const stern = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.2), weathered)
    stern.position.set(-0.25, 0.08, 0)
    const bowL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.2), weathered)
    bowL.position.set(0.29, 0.065, -0.048)
    bowL.rotation.y = -0.5
    const bowR = bowL.clone()
    bowR.position.z = 0.048
    bowR.rotation.y = 0.5
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.3, 6), weathered)
    mast.position.set(-0.05, 0.24, 0)
    mast.rotation.z = 0.24 // it broke
    const sailGeometry = new THREE.BufferGeometry()
    sailGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.03, 0.1, 0, -0.03, 0.37, 0, 0.21, 0.13, 0], 3),
    )
    sailGeometry.computeVertexNormals()
    const sail = new THREE.Mesh(
      sailGeometry,
      new THREE.MeshStandardMaterial({ color: 0x8b7f66, roughness: 0.9, side: THREE.DoubleSide }),
    )
    sail.position.set(-0.05, 0, 0)
    for (const part of [keel, sideL, sideR, stern, bowL, bowR, mast, sail]) {
      part.castShadow = false
      part.receiveShadow = true
      boat.add(part)
    }
    const boatMark = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.22),
      new THREE.MeshBasicMaterial({
        map: this.handprintTexture,
        color: 0x4d2a22,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    boatMark.position.set(0.05, 0.14, 0.105)
    boatMark.rotation.z = -0.18
    boatMark.renderOrder = 2
    boat.add(boatMark)
    this.boatMark = boatMark
    boat.visible = false
    this.microGroup.add(boat)
    this.boat = boat
  }

  /**
   * loop 15: re-dress the set for this layout. Runs inside the reset's
   * full-black hold, so the decals never visibly pop while the walls glide.
   */
  _positionMicroStory(maze) {
    const rng = mulberry32(0x6e77 + maze.loop * 131)
    const dist = distanceMap(maze, maze.entrance)

    // the canonical route: walk the BFS distance down from centre to entrance
    const route = [maze.center]
    while (route.length < maze.size * maze.size) {
      const head = route[route.length - 1]
      const d = dist.get(cellKey(head.r, head.c))
      if (!d) break // distance 0: reached the entrance
      let next = null
      for (const dir of DIRS) {
        if ((maze.open[head.r][head.c] & dir.bit) === 0) continue
        if (dist.get(cellKey(head.r + dir.dr, head.c + dir.dc)) === d - 1) {
          next = { r: head.r + dir.dr, c: head.c + dir.dc }
          break
        }
      }
      if (!next) break
      route.push(next)
    }

    this._positionDebris(route, rng)

    // three engravings along the route (the path you retrace every loop)...
    const placements = []
    for (const fraction of [0.3, 0.55, 0.8]) {
      const index = Math.max(1, Math.min(route.length - 1, Math.round((route.length - 1) * fraction)))
      placements.push(route[index])
    }
    // ...and one beside each shrine cell
    for (const id of SHRINE_IDS) placements.push(maze.shrineCells[id])

    for (let i = 0; i < this.engravings.length; i++) {
      const plane = this.engravings[i]
      let cell = placements[i]
      let dir = this._pickWalledDir(maze, cell.r, cell.c, rng)
      if (!dir) {
        // fully-open junction (extra carves): borrow a walled edge from an
        // adjacent open cell so the engraving still sits beside the landmark
        for (const open of DIRS) {
          if ((maze.open[cell.r][cell.c] & open.bit) === 0) continue
          const neighbour = { r: cell.r + open.dr, c: cell.c + open.dc }
          dir = this._pickWalledDir(maze, neighbour.r, neighbour.c, rng)
          if (dir) {
            cell = neighbour
            break
          }
        }
      }
      if (!dir) {
        plane.visible = false
        continue
      }
      this._placeWallDecal(plane, cell.r, cell.c, dir, 1.08 + rng() * 0.5, (rng() - 0.5) * 0.16)
    }

    this._positionBoat(maze, dist, rng)
  }

  _positionDebris(route, rng) {
    const count = Math.min(this.debrisCapacity, Math.max(0, route.length - 2))
    this.debris.count = count
    for (let i = 0; i < count; i++) {
      const routeIndex = Math.round(((i + 0.5) / count) * (route.length - 1))
      const cell = route[routeIndex]
      const { x, z } = cellToWorld(cell.r, cell.c)
      const scale = 0.55 + rng() * 0.75
      const scaleY = scale * (0.42 + rng() * 0.26)
      this._debrisPosition.set(
        x + (rng() - 0.5) * 1.25,
        0.11 * scaleY + 0.004,
        z + (rng() - 0.5) * 1.25,
      )
      this._debrisScale.set(scale * (0.72 + rng() * 0.4), scaleY, scale * (0.72 + rng() * 0.4))
      this._debrisEuler.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
      this._debrisQuaternion.setFromEuler(this._debrisEuler)
      this._debrisMatrix.compose(this._debrisPosition, this._debrisQuaternion, this._debrisScale)
      this.debris.setMatrixAt(i, this._debrisMatrix)
      this._debrisColor.setRGB(0.18 + rng() * 0.08, 0.2 + rng() * 0.08, 0.22 + rng() * 0.08)
      this.debris.setColorAt(i, this._debrisColor)
    }
    this.debris.instanceMatrix.needsUpdate = true
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true
  }

  /** Seeded pick of a direction whose edge is walled, for decal placement. */
  _pickWalledDir(maze, r, c, rng) {
    const candidates = DIRS.filter((dir) => hasWall(maze, r, c, dir))
    if (candidates.length === 0) return null
    return candidates[Math.floor(rng() * candidates.length)]
  }

  /** Set a decal plane proud of the wall face in `dir`, facing into the cell. */
  _placeWallDecal(plane, r, c, dir, y, tilt) {
    const { x, z } = cellToWorld(r, c)
    const offset = CELL_SIZE / 2 - WALL_THICKNESS / 2 - 0.02
    plane.position.set(x + dir.dc * offset, y, z + dir.dr * offset)
    // the decal normal must point back into the cell the wall belongs to
    plane.rotation.y = Math.atan2(-dir.dc, -dir.dr) + tilt
    plane.visible = true
  }

  /** The boat rests in the deepest dead-end corner clear of every landmark. */
  _positionBoat(maze, dist, rng) {
    const landmarks = [maze.center, ...SHRINE_IDS.map((id) => maze.shrineCells[id])]
    const popcount = (mask) =>
      (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1)
    const deadEnds = []
    for (let r = 0; r < maze.size; r++) {
      for (let c = 0; c < maze.size; c++) {
        if (popcount(maze.open[r][c]) !== 1) continue // dead ends only
        const d = dist.get(cellKey(r, c))
        if (d === undefined) continue // unreachable corner
        if (landmarks.some((lm) => chebyshev(lm, { r, c }) < 2)) continue
        deadEnds.push({ r, c, d })
      }
    }
    if (deadEnds.length === 0) {
      this.boat.visible = false
      return
    }
    deadEnds.sort((a, b) => b.d - a.d) // deepest corners first
    const pick = deadEnds[Math.floor(rng() * Math.min(4, deadEnds.length))]
    const dir = this._pickWalledDir(maze, pick.r, pick.c, rng)
    const { x, z } = cellToWorld(pick.r, pick.c)
    const offset = dir ? CELL_SIZE / 2 - WALL_THICKNESS / 2 - 0.45 : 0
    this.boat.position.set(x + (dir ? dir.dc * offset : 0), 0.002, z + (dir ? dir.dr * offset : 0))
    this.boat.rotation.set(-0.07, rng() * Math.PI * 2, 0.05)
    this.boat.visible = true
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
    this.door.leakLight.visible = open && !this.door.wide
    this.door.doorLight.visible = open
    this.door.hintLight.visible = !open
    this._refreshColliders()
    if (open && !wasOpen && !instant) {
      this.audio?.doorCreak(1.4, this.doorCenter)
      this.doorOpened = true
    }
  }

  /** Both leaves swing outward symmetrically: 0 = shut, 1 = wide open. */
  _applyDoorSwing() {
    this.door.hingeL.rotation.y = -1.5 * this.door.swing
    this.door.hingeR.rotation.y = 1.5 * this.door.swing
  }

  _requestPlayerLock(requestId = null) {
    const id = requestId ?? Symbol('pointer-lock')
    if (requestId === null) this.activeLockRequest = id
    const scene = this.canvas.closest?.('.scene')
    const attempt = () => {
      if (this.disposed) return
      if (requestId === null && this.activeLockRequest !== id) return
      if (requestId !== null && this.resumeRequestId !== id) return
      const inert = scene?.inert || scene?.hasAttribute?.('inert')
      if (inert && requestId === null) {
        queueMicrotask(attempt)
        return
      }
      this.player.requestLock(id)
    }
    attempt()
    return id
  }

  _pauseForFocus() {
    if (!this.startedOnce) return
    if (this.resumePending) {
      this.resumePending = false
      this.resumeRequestId = null
      this.player.cancelLockRequest()
      if (this.resumeFallbackTimer) clearTimeout(this.resumeFallbackTimer)
      this.resumeFallbackTimer = null
      this.audio?.suspend?.()
      return
    }
    const phase = this.store.get().phase
    if (phase === PHASE.PLAYING || phase === PHASE.RESET) {
      this.player.cancelLockRequest()
      this._pause('focus-loss')
    }
  }

  _pause(reason) {
    const phase = this.store.get().phase
    if (phase !== PHASE.PLAYING && phase !== PHASE.RESET) return false
    this.resumePending = false
    if (this.resumeFallbackTimer) {
      clearTimeout(this.resumeFallbackTimer)
      this.resumeFallbackTimer = null
    }
    this.activeLockRequest = null
    this.store.update((state) => pauseGame(state, reason))
    this.player.cancelLockRequest()
    this.player.resetMotion()
    this.player.enabled = false
    this.shake = 0
    this.canvas.tabIndex = -1
    this.canvas.blur?.()
    this.audio?.suspend?.()
    return true
  }

  _handlePointerLock(locked, wasLocked, requestId) {
    if (this.disposed) return
    if (locked) {
      this.ignorePointerUnlock = false
      if (requestId === this.activeLockRequest) this.activeLockRequest = null
      if (this.resumePending && requestId === this.resumeRequestId) this._completeResume(requestId)
      return
    }
    if (wasLocked) {
      if (this.ignorePointerUnlock) {
        this.ignorePointerUnlock = false
        return
      }
      this._pause('pointer-lock')
    }
  }

  _handlePointerLockError(requestId) {
    if (this.disposed) return
    if (this.resumePending && requestId === this.resumeRequestId) {
      this._completeResume(requestId, true)
      return
    }
    if (requestId === this.activeLockRequest) {
      this.activeLockRequest = null
      const phase = this.store.get().phase
      if (phase === PHASE.PLAYING || phase === PHASE.RESET) this._pause('pointer-lock')
    }
  }

  _completeResume(requestId, allowWithoutLock = false) {
    if (this.disposed || !this.resumePending || requestId !== this.resumeRequestId) return
    if (this.resumeFallbackTimer) {
      clearTimeout(this.resumeFallbackTimer)
      this.resumeFallbackTimer = null
    }
    this.resumePending = false
    this.resumeRequestId = null
    this.activeLockRequest = null
    this.store.update(resumeGame)
    this.player.resetMotion()
    this.player.enabled = true
    this.canvas.tabIndex = 0
    this.audio?.resume?.()
    if (this.player.locked || allowWithoutLock) queueMicrotask(() => this.canvas.focus?.())
  }

  _animate(timestamp) {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this._animate)
    this.timer.update(timestamp)
    const rawDt = Math.max(this.timer.getDelta(), 0)
    const dt = Math.min(rawDt, 0.05)
    this._fpsFrames++
    this._fpsAccum += rawDt
    this.update(dt, rawDt)
    const renderState = this.store.get()
    const blackWin = renderState.phase === PHASE.WON && renderState.fade >= 1
    if (renderState.phase !== PHASE.PAUSED && !blackWin) this.renderer.render(this.scene, this.camera)
    if (this._fpsAccum >= 0.5) {
      const fps = Math.round(this._fpsFrames / Math.max(this._fpsAccum, 0.001))
      const render = this.renderer.info?.render
      const memory = this.renderer.info?.memory
      this.renderStats = {
        drawCalls: render?.calls ?? 0,
        triangles: render?.triangles ?? 0,
        geometries: memory?.geometries ?? 0,
        textures: memory?.textures ?? 0,
      }
      this._fpsFrames = 0
      this._fpsAccum = 0
      if (this.store.get().showFps) this.store.set({ fps, renderStats: this.renderStats })
    }
  }

  update(dt, wallDt = dt) {
    const state = this.store.get()
    this.phase = state.phase
    if (this.phase === PHASE.PAUSED) return
    this.animTime += dt
    switch (this.phase) {
      case PHASE.PLAYING:
        this._updatePlaying(dt, state, wallDt)
        break
      case PHASE.RESET:
        this._updateReset(dt, wallDt)
        break
      case PHASE.START:
        // loop 10: the title screen breathes — the camera drifts very slowly
        // in place so the fog visibly swirls behind the overlay
        this._updateStartDrift()
        break
      case PHASE.WON:
        // loop 13: final toll, light holds, black creeps in, ambience released
        this._updateWin(dt, wallDt)
        break
    }
    this._updateFlashlight(dt)
    this._updateShrines(dt)
    this._updateAtmosphere()
    this._updateDoor(dt)
    this._updateSpawnLight(dt)
    // loop 11: the shake writes last so it rides on top of the player's pose
    this._applyShake(dt)
    this.audio?.setListener?.(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      -Math.sin(this.player.yaw),
      0,
      -Math.cos(this.player.yaw),
    )
  }

  /** loop 10: slow breathing camera drift while the title screen is up. */
  _updateStartDrift() {
    if (this.reducedMotion) return
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
    this.player.yaw = base.yaw + Math.sin(t * 0.05) * 0.06
    this.player.pitch = Math.sin(t * 0.06 + 0.7) * 0.02
    this.player._applyCamera()
    this.camera.position.set(
      base.x + Math.sin(t * 0.11) * 0.22,
      base.y + Math.sin(t * 0.07 + 1.3) * 0.045,
      base.z + Math.cos(t * 0.09) * 0.22,
    )
  }

  _updateAudioTension() {
    const stage = this.timeLeft >= 12 ? 0 : this.timeLeft > 6 ? 1 : this.timeLeft > 0 ? 2 : 0
    if (stage === this.audioTensionStage) return
    this.audioTensionStage = stage
    this.audio?.setTension?.(stage / 2)
  }

  _updatePlaying(dt, state, wallDt = dt) {
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
    this.timeLeft = advanceTimer(this.timeLeft, wallDt)
    this._updateAudioTension()
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

  _hasWallBetween(ax, az, bx, bz) {
    return this.maze.walls.some((wall) =>
      segmentIntersectsBox(
        ax,
        az,
        bx,
        bz,
        wall.cx - wall.hx,
        wall.cx + wall.hx,
        wall.cz - wall.hz,
        wall.cz + wall.hz,
      ),
    )
  }

  _findNearestReachableShrine() {
    let nearest = null
    let nearestDistance = PROMPT_RANGE
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      if (shrine.lit) continue
      const dx = this.player.pos.x - shrine.group.position.x
      const dz = this.player.pos.z - shrine.group.position.z
      const distance = Math.hypot(dx, dz)
      if (distance > nearestDistance) continue
      if (this._hasWallBetween(this.player.pos.x, this.player.pos.z, shrine.group.position.x, shrine.group.position.z)) continue
      nearestDistance = distance
      nearest = shrine
    }
    return nearest
  }

  /** The HUD prompt lights up when an unlit shrine is within reach. */
  _updatePrompt(state) {
    this.nearestShrine = this._findNearestReachableShrine()
    const prompt = this.nearestShrine ? 'light' : null
    if (prompt !== state.prompt) this.store.set({ prompt })
  }

  _checkWin() {
    if (!this.doorOpen || !this.doorCenter) return
    if (isInsideChamber(this.player.pos, this.doorCenter, DOOR_WIN_RADIUS)) this._win()
  }

  _win() {
    this.activeLockRequest = null
    this.player.resetMotion()
    this.player.enabled = false
    this.nearestShrine = null
    this.store.set({ phase: PHASE.WON, prompt: null, fade: 0 })
    // the double door swings fully wide as the win light floods in
    this.door.wide = true
    this.door.target = 1
    this.door.leak.visible = false
    this.door.leakLight.visible = false
    this.audio?.winChord()
    // loop 13: choreography state — final toll at 0.9s, black by 4.2s,
    // ambience released once the picture is gone
    this.winElapsed = 0
    this.winTolled = false
    this.winAmbientStopped = false
    this.ignorePointerUnlock = true
    if (typeof document.exitPointerLock === 'function') document.exitPointerLock()
  }

  /** loop 13: the win plays out — toll, light swells, then black takes it. */
  _updateWin(dt, wallDt = dt) {
    this.winElapsed += wallDt
    const elapsed = this.winElapsed

    // one last, very low toll — the loop closing behind you
    if (!this.winTolled && elapsed >= 0.9) {
      this.winTolled = true
      this.audio?.bellToll(0, 110, 0.5)
      this.addShake(0.05)
      this._vibrate([24, 90, 40]) // loop 15: the loop closes against your hand
    }

    // the black creeps in only after the chord has had its moment
    const FADE_DELAY = 1.6
    const FADE_TIME = 2.6
    const fade =
      elapsed <= FADE_DELAY ? 0 : Math.min(1, (elapsed - FADE_DELAY) / FADE_TIME)
    this.store.set({ fade })

    // release the ambience once the screen is fully dark
    if (!this.winAmbientStopped && elapsed >= FADE_DELAY + FADE_TIME + 0.4) {
      this.winAmbientStopped = true
      this.audio?.stopAmbient()
    }
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
    // loop 11: snapshot the old layout so the walls can glide to the new one
    this._captureWallPositions()
    this.wallAnimT = 0
    this.resetTollIndex = 0 // shake lands with each toll in _updateReset
    this.timeLeft = LOOP_SECONDS
    this.audioTensionStage = 0
    this.audio?.setTension?.(0)
  }

  _updateReset(dt, wallDt = dt) {
    this.resetElapsed += wallDt
    const elapsed = this.resetElapsed

    // loop 11: the shake lands with every toll, decaying between them
    while (
      this.resetTollIndex < RESET_TIMELINE.tolls &&
      elapsed >= this.resetTollIndex * RESET_TIMELINE.tollSpacing
    ) {
      this.addShake(0.055)
      this._vibrate(16) // loop 15: each toll lands in the controller too
      this.resetTollIndex++
    }

    if (!this.swapped && elapsed >= RESET_SWAP_AT) {
      this.swapped = true
      this._swapLoop()
    }

    if (this.swapped && this.wallAnimFrom) {
      const slideDuration = RESET_TIMELINE.rise + 0.24
      this.wallAnimT = Math.min(1, Math.max(0, (elapsed - RESET_SWAP_AT) / slideDuration))
      if (this.wallAnimT >= 1) this.wallAnimFrom = null
    }

    if (this.swapped) {
      this._updateWallMatrices((entry) => wallRiseProgress(elapsed, entry.delay))
      // frozen while the floor is still swallowing the layout
      this.player.enabled = false
    } else {
      this._updateWallMatrices(() => wallSinkProgress(elapsed))
      this.player.update(dt)
    }

    this.store.set({ fade: resetFade(elapsed), timeLeft: LOOP_SECONDS })
    if (elapsed >= RESET_TIMELINE.total) {
      this.player.enabled = true
      this.store.set({ phase: PHASE.PLAYING })
    }
  }

  /**
   * loop 11: kick the screenshake. Amplitude is clamped so stacked tolls
   * cannot fling the camera through a wall.
   */
  addShake(amount) {
    this.shake = Math.min(0.14, this.shake + amount)
  }

  /**
   * loop 15: controller vibration on the bell and the candles. The Vibration
   * API is a silent no-op wherever it is unsupported (most desktops, iOS), so
   * this is guarded and best-effort — pure extra texture where it exists.
   */
  _vibrate(pattern) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
    try {
      navigator.vibrate(pattern)
    } catch {
      /* haptics are strictly optional */
    }
  }

  /** loop 11: apply the decaying shake offset after the player's camera write. */
  _applyShake(dt) {
    if (this.reducedMotion) {
      this.shake = 0
      return
    }
    if (this.shake <= 0.0005) {
      this.shake = 0
      return
    }
    this.shake *= Math.exp(-2.6 * dt)
    const t = this.animTime * 31 + this._shakeSeed
    this.camera.position.x += Math.sin(t * 1.1) * this.shake
    this.camera.position.y += Math.sin(t * 1.7 + 1.2) * this.shake * 0.6
    this.camera.rotation.z += Math.sin(t * 0.9 + 0.5) * this.shake * 0.35
  }

  /** Everything the bell changes: layout, shrines, door, spawn, loop counter. */
  _swapLoop() {
    const candles = this.store.get().candles
    const doorOpen = shouldDoorOpenAtLoopStart(candles)
    const announceDoor = doorOpen && !this.doorOpen
    this._loadMaze(this.nextLoopNumber, { doorOpen, doorInstant: !announceDoor })
    this._pairWallAnimations()
    this._updateWallMatrices(() => 0) // the new walls wait under the floor
    this.store.update((state) => beginLoop(state, this.nextLoopNumber, PHASE.RESET))
    this.timeLeft = LOOP_SECONDS
    if (announceDoor) {
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
    this.flashlightFill.position.set(
      this.camera.position.x + 0.08,
      this.camera.position.y + 0.06,
      this.camera.position.z,
    )
    this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
    this._flashDesired.copy(this.camera.position).addScaledVector(this._forward, 9)
    // the lag: the cone catches up with where you are looking
    this.flashlightTarget.position.lerp(this._flashDesired, 1 - Math.exp(-5.5 * dt))

    // loop 6: battery dying as the bell approaches — in the last 8 seconds the
    // lamp browns out in irregular dips, then recovers after the reset
    const BASE = 14
    let desired = BASE
    if (this.phase === PHASE.PLAYING && this.timeLeft < 8) {
      const danger = 1 - this.timeLeft / 8
      const dip = Math.max(0, flickerNoise(this.animTime * 2.3 + 1.4)) * danger
      desired = BASE * (1 - 0.5 * dip)
    } else if (this.phase === PHASE.RESET) {
      const reveal = clamp01((this.resetElapsed - RESET_SWAP_AT) / RESET_TIMELINE.fadeIn)
      desired *= 0.35 + 0.65 * reveal
    }
    this.flashlight.intensity += (desired - this.flashlight.intensity) * (1 - Math.exp(-11 * dt))
    this.flashlightFill.intensity = 0.7 * (this.flashlight.intensity / BASE)
    // colour cools as it browns out
    const warmth = this.flashlight.intensity / BASE
    this.flashlight.color.copy(this.flashlightDim).lerp(this.flashlightWarm, warmth)
  }

  _updateShrines(dt) {
    for (const id of SHRINE_IDS) {
      const shrine = this.shrines.get(id)
      if (!shrine.lit) continue
      shrine.level += (1 - shrine.level) * (1 - Math.exp(-4 * dt))
      const noise = flickerNoise(this.animTime + shrine.flicker)
      const n01 = 0.5 + 0.5 * noise
      shrine.embers.visible = shrine.lit && !this.reducedMotion
      if (this.reducedMotion) {
        shrine.flames.forEach((flame, layer) => {
          flame.position.x = 0
          flame.position.y = 1.3 + layer * 0.02
          const s = 0.44 - layer * 0.1
          flame.scale.set(s, s * 1.15, 1)
          flame.material.opacity = 0.8 - layer * 0.22
        })
        shrine.flameLight.intensity = shrine.baseIntensity * shrine.level
        shrine.flameLight.distance = 5.2
        shrine.halo.scale.setScalar(0.9)
        shrine.halo.material.opacity = 0.025
        continue
      }
      // layered flame: each layer bobs and sways at its own frequency
      shrine.flames.forEach((flame, layer) => {
        const wobble = flickerNoise(this.animTime * (1.6 + layer * 0.7) + shrine.flicker + layer * 2.1)
        flame.position.x = wobble * (0.014 + layer * 0.008)
        flame.position.y = 1.3 + layer * 0.02 + n01 * 0.015
        const s = (0.44 - layer * 0.1) * shrine.level
        flame.scale.set(s * (0.9 + 0.1 * n01), s * (1.05 + 0.2 * n01), 1)
        flame.material.opacity = (0.8 - layer * 0.22) * shrine.level * (0.85 + 0.15 * n01)
      })
      // pulsing point light: intensity flicker + breathing radius
      shrine.flameLight.intensity = shrine.baseIntensity * shrine.level * (0.82 + 0.18 * n01)
      shrine.flameLight.distance = 4.8 + 0.8 * n01
      shrine.halo.scale.setScalar(0.9 + 0.25 * n01)
      shrine.halo.material.opacity = 0.025 + 0.025 * n01

      const positions = shrine.embers.geometry.attributes.position
      const array = positions.array
      const colors = shrine.embers.geometry.attributes.color
      const colorArray = colors.array
      for (let i = 0; i < shrine.emberSeeds.length / 5; i++) {
        const seed = i * 5
        const baseX = shrine.emberSeeds[seed]
        const baseZ = shrine.emberSeeds[seed + 1]
        const speed = shrine.emberSeeds[seed + 2]
        const phase = shrine.emberSeeds[seed + 3]
        const drift = shrine.emberSeeds[seed + 4]
        const life = (this.animTime * speed + phase) % 1
        const sway = Math.sin(this.animTime * drift + phase * Math.PI * 2 + shrine.flicker) * (0.015 + life * 0.035)
        const cross = Math.cos(this.animTime * drift * 0.73 + phase * 5.1) * (0.008 + life * 0.02)
        const idx = i * 3
        array[idx] = baseX + sway
        array[idx + 1] = 1.2 + life * 0.75
        array[idx + 2] = baseZ + cross
        const heat = Math.sin(life * Math.PI)
        colorArray[idx] = heat
        colorArray[idx + 1] = heat * (0.52 + 0.24 * Math.sin(phase * 11.3))
        colorArray[idx + 2] = heat * (0.12 + 0.08 * Math.sin(phase * 7.1))
      }
      positions.needsUpdate = true
      colors.needsUpdate = true
      shrine.embers.material.opacity = (0.45 + 0.2 * n01) * shrine.level
      shrine.embers.material.size = 0.026 + 0.008 * n01
    }
  }

  _updateAtmosphere() {
    if (this.reducedMotion) {
      this.dust.material.opacity = this.startedOnce ? 0.06 : 0.04
      return
    }
    const positions = this.dust.geometry.attributes.position
    const array = positions.array
    for (let i = 0; i < this.dustSeeds.length / 6; i++) {
      const seed = i * 6
      const phase = this.dustSeeds[seed + 3]
      const drift = this.dustSeeds[seed + 4]
      const speed = this.dustSeeds[seed + 5]
      const wave = Math.sin(this.animTime * speed * Math.PI * 2 + phase * Math.PI * 2)
      const idx = i * 3
      array[idx] = this.dustSeeds[seed] + Math.sin(this.animTime * drift + phase * 4.2) * 0.035
      array[idx + 1] = this.dustSeeds[seed + 1] + wave * 0.08
      array[idx + 2] = this.dustSeeds[seed + 2] + Math.cos(this.animTime * drift * 0.81 + phase * 5.7) * 0.028
    }
    positions.needsUpdate = true
    this.dust.material.opacity = this.startedOnce ? 0.12 : 0.08
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
    const armed = !door.doorLight.visible && candlesLit(this.store.get().candles) === SHRINE_IDS.length
    if (armed) {
      const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.animTime * 2.2)
      door.hintLight.color.setHex(0xb07a3c)
      door.hintLight.intensity = 0.8 + pulse * 0.8
    } else {
      door.hintLight.color.setHex(0x2a3a55)
      door.hintLight.intensity = 1.1
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
      this.spawnLight.intensity = 2.2
      this.spawnLight.visible = true
      return
    }
    this.spawnElapsed += dt
    const t = this.spawnElapsed
    const intensity = t < 0.4 ? (t / 0.4) * 9 : Math.max(0.65, 9 * (1 - (t - 0.4) / 5.5))
    this.spawnLight.visible = intensity > 0.01
    this.spawnLight.intensity = intensity
  }

  // -------------------------------------------------------------------------
  // public API used by React
  // -------------------------------------------------------------------------

  setReviewState(name) {
    if (!REVIEW_STATES.has(name)) return false
    this.reviewState = name
    this.resumePending = false
    this.resumeRequestId = null
    this.activeLockRequest = null
    if (this.resumeFallbackTimer) clearTimeout(this.resumeFallbackTimer)
    this.resumeFallbackTimer = null
    this.audio?.silence?.()
    this.audio?.stopAmbient?.()
    this.store.set({ ...createInitialState(1, PHASE.PLAYING), phase: PHASE.PLAYING, fade: 0 })
    this._loadMaze(1, { doorOpen: false, doorInstant: true })
    this.player.cancelLockRequest()
    this.player.resetMotion()
    this.startedOnce = true
    this.introActive = false
    this.phase = PHASE.PLAYING
    this.wallAnimFrom = null
    this.wallAnimT = 0
    this.resetElapsed = 0
    this.swapped = false
    this.nextLoopNumber = 1
    this._startDriftBase = null
    this._updateWallMatrices(() => 1)
    this.player.enabled = true
    this.timeLeft = LOOP_SECONDS
    if (name === 'reset') {
      this._beginReset()
      return true
    }
    if (name === 'entry') {
      const entrance = cellToWorld(this.maze.entrance.r, this.maze.entrance.c)
      this.player.teleport(entrance.x, entrance.z, ENTRANCE_YAW)
      return true
    }
    if (name === 'shrine') {
      const shrine = this.shrines.get(SHRINE_IDS[0])
      const position = cellToWorld(shrine.cell.r, shrine.cell.c)
      this.player.teleport(position.x, position.z + 2.05, 0)
      this._lightShrine(shrine)
      return true
    }
    if (name === 'win') {
      const center = cellToWorld(this.maze.center.r, this.maze.center.c)
      const direction = {
        N: { x: 0, z: -1 },
        E: { x: 1, z: 0 },
        S: { x: 0, z: 1 },
        W: { x: -1, z: 0 },
      }[this.maze.centerApproach]
      this.player.teleport(center.x + direction.x * 2.4, center.z + direction.z * 2.4, Math.atan2(direction.x, direction.z))
      this.store.set({ candles: { A: true, B: true, C: true } })
      this._applyShrineStates()
      this._setDoorOpen(true, true)
      this._win()
      this.door.swing = 1
      this._applyDoorSwing()
      return true
    }
    const center = cellToWorld(this.maze.center.r, this.maze.center.c)
    const direction = {
      N: { x: 0, z: -1 },
      E: { x: 1, z: 0 },
      S: { x: 0, z: 1 },
      W: { x: -1, z: 0 },
    }[this.maze.centerApproach]
    this.player.teleport(center.x + direction.x * 2.4, center.z + direction.z * 2.4, Math.atan2(direction.x, direction.z))
    return true
  }

  /** BEGIN: freeze-off, walls rise, black lifts, pointer lock, first toll. */
  start() {
    if (this.startedOnce) return
    this.startedOnce = true
    this.introActive = true
    this.introElapsed = 0
    this.spawnElapsed = 0
    this.spawnLight.visible = true
    this.timeLeft = LOOP_SECONDS
    this.audioTensionStage = 0
    this.audio?.setTension?.(0)
    const entrance = cellToWorld(this.maze.entrance.r, this.maze.entrance.c)
    this.player.teleport(entrance.x, entrance.z, ENTRANCE_YAW)
    this.player.resetMotion()
    this._updateWallMatrices(() => 0)
    this.player.enabled = true
    this.canvas.tabIndex = 0
    this.store.set({ phase: PHASE.PLAYING, timeLeft: LOOP_SECONDS, fade: 1, prompt: null })
    this._requestPlayerLock()
    queueMicrotask(() => this.canvas.focus?.())
    this.audio?.bellToll(0, 220, 0.5)
  }

  resume() {
    if (this.disposed || this.store.get().phase !== PHASE.PAUSED || this.resumePending) return false
    this.resumePending = true
    const requestId = Symbol('bell-loop-resume')
    this.resumeRequestId = requestId
    this.resumeFallbackTimer = setTimeout(() => {
      if (this.resumePending && this.resumeRequestId === requestId) {
        this.player.cancelLockRequest()
        this._completeResume(requestId, true)
      }
    }, 750)
    this.resumeFallbackTimer.unref?.()
    this._requestPlayerLock(requestId)
    if (this.player.locked && this.resumeRequestId === requestId) this._completeResume(requestId)
    return true
  }

  /** BEGIN AGAIN: wipe the run and replay loop 1 through the same transition. */
  restart() {
    this.audio?.silence?.()
    this.audio?.stopAmbient?.()
    this.resumePending = false
    this.resumeRequestId = null
    this.activeLockRequest = null
    if (this.resumeFallbackTimer) clearTimeout(this.resumeFallbackTimer)
    this.resumeFallbackTimer = null
    this.player.cancelLockRequest()
    this.player.resetMotion()
    this.nextLoopNumber = 1
    this.resetElapsed = 0
    this.swapped = false
    this.wallAnimFrom = null
    this.wallAnimT = 0
    this.resetTollIndex = 0
    this.introActive = false
    this.doorOpened = false
    this.door.wide = false
    this.ignorePointerUnlock = false
    this.nearestShrine = null
    this._startDriftBase = null
    this.startedOnce = true
    this.phase = PHASE.RESET
    const entrance = cellToWorld(this.maze.entrance.r, this.maze.entrance.c)
    this.player.teleport(entrance.x, entrance.z, ENTRANCE_YAW)
    this.player.enabled = false
    this.timeLeft = LOOP_SECONDS
    this.audioTensionStage = 0
    this.audio?.setTension?.(0)
    this.store.set({ ...restartState(1), phase: PHASE.RESET, fade: 0 })
    this._applyShrineStates()
    this._setDoorOpen(false, true)
    this.spawnElapsed = 0
    this.spawnLight.visible = true
    this._requestPlayerLock()
    queueMicrotask(() => this.canvas.focus?.())
    this.audio?.bellSequence(RESET_TIMELINE.tolls, RESET_TIMELINE.tollSpacing)
  }

  /** E / click: light the shrine the player is standing next to. */
  tryLight() {
    if (this.store.get().phase !== PHASE.PLAYING) return false
    const shrine = this._findNearestReachableShrine()
    if (!shrine) return false
    this.nearestShrine = shrine
    return this._lightShrine(shrine)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.resumePending = false
    this.resumeRequestId = null
    cancelAnimationFrame(this.rafId)
    if (this.resumeFallbackTimer) clearTimeout(this.resumeFallbackTimer)
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('blur', this._onWindowBlur)
    window.removeEventListener('resize', this._onWindowResize)
    document.removeEventListener('visibilitychange', this._onVisibilityChange)
    this.canvas.removeEventListener('mousedown', this._onMouseDown)
    this._resizeObserver?.disconnect()
    if (this._motionQuery?.removeEventListener) this._motionQuery.removeEventListener('change', this._onMotionPreference)
    else this._motionQuery?.removeListener?.(this._onMotionPreference)
    this.player.cancelLockRequest()
    this.audio?.dispose?.()
    if (typeof document !== 'undefined' && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.()
    }
    this.player.dispose()
    const seenTextures = new Set()
    const seenGeometries = new Set()
    const seenMaterials = new Set()
    this.scene.traverse((object) => {
      if (object.geometry && !seenGeometries.has(object.geometry)) {
        seenGeometries.add(object.geometry)
        object.geometry.dispose()
      }
      const materials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : []
      for (const material of materials) {
        if (seenMaterials.has(material)) continue
        seenMaterials.add(material)
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
    this.flashlight.shadow?.dispose?.()
    this.renderer.dispose()
    this.timer.dispose()
    this.canvas.parentNode?.removeChild(this.canvas)
  }
}
