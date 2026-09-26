/**
 * streetView.js — the v2 street: chunk geometry, per-loop fixtures, the three
 * portals, the hammer, the exit car, and the collider rebuild (slice 09).
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * §15.1 splits v1's 1,967-line `world.js` three ways, and this is the middle one.
 * `world.js` keeps the scene, the lights, the phase machine and the simulation
 * loop; `creatureView.js` (slice 10) will own the thing that hunts you. Everything
 * in *this* file is a function of pure data from `neighborhood.js` — `chunkAt`,
 * `chunkFixtures`, `placeObjectives` — turned into meshes and into an AABB list.
 * Nothing here decides a rule; it draws the ones it is handed.
 *
 * THE WRAP
 * --------
 * §3.1 is a 7 x 7 grid that wraps toroidally, and the property the manual check
 * for this slice asks about is that the wrap is *seamless in all four
 * directions*. The technique is one group containing three copies of the whole
 * neighbourhood, at `-WORLD_EXTENT`, `0` and `+WORLD_EXTENT`, and it is exactly the
 * "the view layer draws the folded copy as well" that `neighborhood.js`'s header
 * promised when it made `blockCentre` return UNFOLDED coordinates that can leave
 * ±WORLD_HALF.
 *
 * The group is then snapped to the copy nearest the player (`recentre`), and the
 * collider and occluder lists are translated with it. Two consequences fall out
 * of that, and both are load-bearing:
 *
 *  - The player never wraps. Their coordinates run monotonically, which keeps
 *    footstep integration, `wrapDelta` distances and the camera continuous. Only
 *    the world moves, and it only ever moves by whole periods, so the swap
 *    happens behind the player's back at 448 m of travel and identical content
 *    arrives in its place.
 *  - The collision set is always the one copy the player is standing in, so
 *    "walking into a hedge collides" cannot become "walking into the same hedge
 *    448 m away does not". That is the bug class a torus quietly invites and the
 *    reason `colliders()` is a function of the current origin rather than a
 *    constant array.
 *
 * INSTANCING
 * ----------
 * Everything repeated is an `InstancedMesh` over a unit box, scaled per instance,
 * because the alternative is a scene graph of ~4,600 objects and this file is the
 * one that has to stay cheap enough to also hold the creature. Instance matrices
 * are written from a canonical copy of the data and flushed on `commit()`, so a
 * per-loop fixture rebuild (§3.6: a discrete event at reset, not a per-frame
 * cost) is a matrix rewrite, not a geometry rebuild.
 *
 * NOT PURE, and that is deliberate: it imports Three.js, so `verify.mjs` cannot
 * import it and every number it draws is asserted upstream in `neighborhood.js`,
 * `rules.js` and `creature.js` instead. What the gate *can* assert about this file
 * is its source contract — which modules it imports, what it exports, and that it
 * never reaches back into v1's `maze.js`, which slice 09 added as a check and
 * slice 16 made vacuously true by deleting the file.
 */
import * as THREE from 'three'
import {
  CHUNKS,
  DECORATIVE_KINDS,
  FIXTURE_DENSITY,
  GRID,
  PORTAL_IDS,
  SIDE_NAMES,
  STREET_HALF_WIDTH,
  STRUCTURAL_KINDS,
  WORLD_EXTENT,
  chunkAt,
  chunkFixtures,
  originFor,
  placeObjectives,
  reservedLots,
  roadAxisToWorld,
  streetNodeToWorld,
} from './neighborhood.js'
// The one import that is not geometry: §6.3's list of what blocks a sightline.
// Taking the table from the module that reasons about sight rather than restating
// it here is the whole reason hedges are occluders in the AI and in the renderer
// at the same time. `creature.js` is pure — no DOM, no Three.js — so importing it
// costs this file nothing.
import { OCCLUDER_KINDS } from './creature.js'

// ---------------------------------------------------------------------------
// palette (§12.3) — extended from v1's PALETTE, which lived in world.js
// ---------------------------------------------------------------------------

/**
 * §12.3's anchors, plus the three sky and fog stops §3.7 slides between.
 *
 * Two light families and they never mix (§12.2): `sodium` is the neighbourhood —
 * streetlights, porch lights, the exit's headlights — and `portal` is the only
 * cold light in the game, so a cyan glow through a gap between two houses reads
 * as *wrong* with no UI saying so. The three sky stops are the "dusk, not night"
 * constraint in three hex values: the horizon is still lit at stage 0 and the
 * world is nearly gone by stage 3, and §12.1's reason for the whole ramp is that a
 * fully dark world would hide the creature and a fully lit one would remove the
 * fog.
 */
export const PALETTE = Object.freeze({
  skyStops: Object.freeze([0x2a2233, 0x4a3550, 0x12101a]),
  fogStops: Object.freeze([0x241d2a, 0x1e1826, 0x141018]),
  asphalt: 0x17151b,
  sidewalk: 0x2b2830,
  kerb: 0x35313b,
  siding: Object.freeze([0x3a3540, 0x4a4038]),
  roof: 0x1d1a22,
  hedge: 0x1e2a1e,
  fence: 0x2a2620,
  yard: 0x232028,
  carBody: 0x241f28,
  portal: 0x3ad6d6,
  portalDead: 0x0b2b2b,
  sodium: 0xffa54a,
  headlight: 0xffe2a8,
  creature: 0x08070a,
})

/** §5.1: one portal per liminal structure, in PORTAL_IDS order. */
export const PORTAL_STRUCTURES = Object.freeze(['shed', 'busShelter', 'phoneBox'])

/**
 * Which way each structure opens, in its own local axes, in the same order.
 *
 * The three shells are not three copies of one box and the difference is the
 * whole reason a camera has to be told: the shed is walled front and back and
 * gapped on its +X flank, the bus shelter has a back panel at -Z and nothing at
 * +Z, and the phone box is a closed cube the ring reads through. Standing
 * "north of the portal" therefore photographs the back of two of the three, and
 * the §16.5.5 capture did exactly that — a flat black panel with a cyan sliver
 * under its roofline, measured at 0.33% lit.
 *
 * This is stated here, beside the geometry that makes it true, rather than
 * worked out at capture time from a bounding box: which way a door faces is a
 * fact about the model, and a second place that re-derives it from geometry is a
 * second thing that can be wrong about the door.
 */
const PORTAL_OPEN_AXIS = Object.freeze(['x', 'z', 'z'])

/** How many wrapped copies of the neighbourhood exist. §3.1 needs no more. */
export const WRAP_COPIES = Object.freeze([-1, 0, 1])

/** Metres of road either side of a centreline; the kerb and the walk sit outside. */
const KERB_WIDTH = 0.4
const SIDEWALK_WIDTH = 3
/** Length of one straight run of road/sidewalk: three periods, so it never ends. */
const RUN_LENGTH = WORLD_EXTENT * 3
const WALL_HEIGHT = 5.2
const ROOF_HEIGHT = 1.9

/**
 * How wide a sodium pool is on the road, metres.
 *
 * Sized to the street rather than to the light: the carriageway is `2 *
 * STREET_HALF_WIDTH` = 12 m wide, so a 12 m pool fills the road it stands on and
 * stops at the kerb, which is what makes the pools read as a *grid you steer by*
 * (§4's second navigation mechanism) rather than as a smear. A smaller pool reads
 * as a spotlight on a stage and loses the spacing; a larger one runs the pools
 * together and the grid stops being legible at all.
 */
const LAMP_POOL_DIAMETER = 12

/**
 * The cyan apron's diameter, metres. A quarter of the sodium pool's 12, which is
 * the ratio of the things themselves: §12.2's portal stands in a doorway and
 * lights the ground a player walks onto, where a lamp lights a street. It is
 * still wide enough to reach under a camera standing at §5.2's hold distance,
 * which is the measurement the two portal captures are actually judged on.
 */
const PORTAL_APRON_DIAMETER = 7

/**
 * The top face of a lot's yard slab, metres. `pools.yards.place` is called with
 * this as its centre and 0.1 as its height, so the surface a portal's apron has
 * to clear is `YARD_TOP` and not the road's y=0 — see the apron's own comment for
 * what happens when a decal is laid at the road's height inside a lot.
 */
const YARD_TOP = 0.1


// ---------------------------------------------------------------------------
// procedural textures — canvas, no downloads, and no path drawing
// ---------------------------------------------------------------------------

/**
 * Every texture here is written pixel-by-pixel through `createImageData` /
 * `putImageData` rather than through paths.
 *
 * That is not a style preference. `verify-world.mjs` stubs the 2D canvas context
 * with exactly five members — `createImageData`, `putImageData`, `fillRect`,
 * `globalAlpha`, `fillStyle` — and v1's six procedural textures rotted against
 * that stub silently because nothing ran the harness (GAMEDESIGN §15.3). Writing
 * v2's textures inside the stub's surface means this file can be constructed by the
 * existing harness unchanged, which is how slice 09 smoke-tested the swap without
 * touching the harness slice 14 owns.
 */

/** Deterministic value noise, so a texture is a function of its seed alone. */
function noiseField(seed) {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // a coarse lattice, bilinearly interpolated: cheap, smooth, and tileable enough
  // at the repeat counts below that the seam is not readable through fog
  const cells = 8
  const grid = []
  for (let y = 0; y <= cells; y += 1) {
    const row = []
    for (let x = 0; x <= cells; x += 1) row.push(rand())
    grid.push(row)
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  return (u, v) => {
    const gx = u * cells
    const gy = v * cells
    const x0 = Math.floor(gx) % cells
    const y0 = Math.floor(gy) % cells
    const x1 = (x0 + 1) % cells
    const y1 = (y0 + 1) % cells
    const tx = smooth(gx - Math.floor(gx))
    const ty = smooth(gy - Math.floor(gy))
    const top = grid[y0][x0] * (1 - tx) + grid[y0][x1] * tx
    const bottom = grid[y1][x0] * (1 - tx) + grid[y1][x1] * tx
    return top * (1 - ty) + bottom * ty
  }
}

/**
 * A greyscale multiply texture: `base` scaled by noise, with a per-pixel dither.
 * Shared by every surface below, and the only texture primitive in the file.
 */
function makeSurfaceTexture({ size = 128, seed = 1, base = 0.5, contrast = 0.3, grain = 0.06, repeat = 1, stripes = 0 }) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const noise = noiseField(seed)
  const image = ctx.createImageData(size, size)
  const data = image.data
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      let tone = base + (noise(u, v) - 0.5) * contrast
      if (stripes > 0) {
        // siding boards: a hard period in u, so the wall reads as boards
        const board = Math.abs(((u * stripes) % 1) - 0.5) * 2
        tone *= 0.86 + 0.14 * board
      }
      const dither = (noise(u * 3.1, v * 3.7) - 0.5) * grain
      const value = Math.max(0, Math.min(255, Math.round((tone + dither) * 255)))
      const i = (y * size + x) * 4
      data[i] = value
      data[i + 1] = value
      data[i + 2] = value
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(repeat, repeat)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The four surface seeds, in one place, because a texture whose seed is typed at
 * its call site is a texture two people will change differently. Asphalt is dark
 * and high-contrast so the sodium pools have something to sit on; the walk is
 * lighter and calmer so the road reads as the darker of the two; siding carries
 * board lines; the hedge is the noisiest of the four, which is the cheapest way to
 * make a box read as foliage at 40 m.
 */
/**
 * The sodium pool's own texture: a radial falloff, written as alpha rather than
 * as colour, so one texture serves every pool at every brightness the flicker
 * puts it at.
 *
 * Drawn per-pixel through `createImageData`/`putImageData` for the reason every
 * other texture in this file is: `verify-world.mjs` stubs the 2D context with
 * exactly these members, and a texture written with a gradient primitive would
 * be a texture the gate cannot construct. The falloff is `(1 - r²)²` because a
 * linear ramp reads as a painted disc with a hard edge, and a sodium lamp on wet
 * asphalt has neither — it is bright under the head and gone well before the
 * kerb.
 */
function makePoolTexture({ size = 128, peak = 1 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(size, size)
  const data = image.data
  const half = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half
      const dy = (y - half) / half
      const r2 = dx * dx + dy * dy
      const fall = r2 >= 1 ? 0 : (1 - r2) * (1 - r2) * peak
      const value = Math.round(fall * 255)
      const i = (y * size + x) * 4
      // white in RGB and the falloff in alpha, so the material's own colour is the
      // sodium hue and the pool flickers with the lamp head it belongs to
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = value
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}


export const SURFACE_SEEDS = Object.freeze({
  asphalt: 0x515f,
  sidewalk: 0x51de,
  siding: 0x51d1,
  hedge: 0x4ed9,
})

// ---------------------------------------------------------------------------
// instancing
// ---------------------------------------------------------------------------

/**
 * One `InstancedMesh` over a unit primitive, written in canonical coordinates and
 * flushed on `commit()`.
 *
 * `frustumCulled` is off deliberately. With three wrapped copies the geometry
 * spans 1,344 m and the camera is essentially always inside it, so per-frame
 * culling work buys nothing, and a stale instance bounding sphere after a fixture
 * rebuild would be a real (if invisible) failure mode.
 */
class InstancePool {
  constructor(geometry, material, capacity, name) {
    this.capacity = capacity
    this.used = 0
    this.overflow = 0
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity)
    this.mesh.name = name
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this._matrix = new THREE.Matrix4()
    this._position = new THREE.Vector3()
    this._quaternion = new THREE.Quaternion()
    this._scale = new THREE.Vector3()
    this._euler = new THREE.Euler()
  }

  /**
   * Place one instance. An over-capacity write is counted rather than thrown: a
   * fixture kind that outgrows its pool is a capacity bug, and dropping the
   * geometry silently would turn it into a hole in the world instead.
   */
  place(x, y, z, w, h, d, yaw = 0) {
    if (this.used >= this.capacity) {
      this.overflow += 1
      return false
    }
    this._position.set(x, y, z)
    this._euler.set(0, yaw, 0)
    this._quaternion.setFromEuler(this._euler)
    this._scale.set(w, h, d)
    this._matrix.compose(this._position, this._quaternion, this._scale)
    this.mesh.setMatrixAt(this.used, this._matrix)
    this.used += 1
    return true
  }

  clear() {
    this.used = 0
    this.overflow = 0
  }

  commit() {
    this.mesh.count = this.used
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    // geometry only: the materials are shared and owned by `_materials`, and
    // disposing them here would tear them out from under every other pool
    this.mesh.geometry.dispose()
  }
}

/**
 * Every fixture kind gets its own pool, and this is how a kind becomes a shape:
 * the pure module decides *what* and *where*, this table decides how tall it is
 * and how high off the ground it sits. Heights are art, not rules — §3.6's four
 * constraints are all about footprint, which comes from `neighborhood.js`.
 */
const FIXTURE_SHAPES = Object.freeze({
  hedge: { h: 1.3, lift: 0 },
  car: { h: 1.45, lift: 0.1 },
  bin: { h: 1.0, lift: 0 },
  fence: { h: 1.1, lift: 0 },
  shed: { h: 2.2, lift: 0 },
  window: { h: 1.2, lift: 1.5 },
  porchLight: { h: 0.5, lift: 2.4 },
  stake: { h: 0.7, lift: 0 },
  cone: { h: 0.6, lift: 0 },
})

/** The four frontages, as the yaw whose local -Z faces the street. */
const FRONT_YAW = Object.freeze({ N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 })

/**
 * lotFrame — the geometry of one lot, in the two frames this file keeps mixing.
 *
 * `short` is the depth from the street frontage to the back of the lot (always
 * `LOT_DEPTH`, 10 m) and `long` is how far it runs along the street (26 m). Lots
 * on the N and S sides are wide and shallow, lots on the E and W sides are narrow
 * and deep, and every box placed on a lot has to know which way round it is —
 * which is the entire reason this helper exists rather than four cases inline.
 */
function lotFrame(lot) {
  const alongX = lot.w >= lot.d
  const half = (alongX ? lot.d : lot.w) / 2
  const outwardZ = lot.side === 'N' ? -1 : lot.side === 'S' ? 1 : 0
  const outwardX = lot.side === 'W' ? -1 : lot.side === 'E' ? 1 : 0
  const front = alongX ? lot.z + outwardZ * half : lot.x + outwardX * half
  const back = alongX ? lot.z - outwardZ * half : lot.x - outwardX * half
  return { alongX, front, back, short: half * 2, long: alongX ? lot.w : lot.d, yaw: FRONT_YAW[lot.side] }
}

/** A coordinate `offset` metres in from the front face, `depth` deep. */
function atDepth(frame, offset, depth) {
  const sign = frame.back >= frame.front ? 1 : -1
  return frame.front + sign * (offset + depth / 2)
}

/**
 * The canonical draw window, in metres: the western edge of block 0 to the
 * eastern edge of block `GRID - 1`, which is exactly one period wide.
 *
 * It is NOT `[-WORLD_EXTENT / 2, +WORLD_EXTENT / 2]`. The fold window and the
 * draw window are 192 m out of step with each other, because the block grid runs
 * from the first road axis to one block past the last one. Snapping the world to
 * `round(x / WORLD_EXTENT) * WORLD_EXTENT` therefore leaves a 192 m band along the
 * western edge in which the player is standing in the one part of the tile that
 * draws no blocks at all — a strip of bare asphalt with the neighbourhood 192 m
 * behind them. Deriving the window from the module's own numbers is the fix, and
 * `verify.mjs` asserts the player's folded position is inside it in all four
 * directions.
 *
 * Slice 15 moved the window itself: it is `neighborhood.js`'s `CANONICAL_ORIGIN`
 * and `originFor` now, because the balance simulation needed the same fold in a
 * pure module and two definitions of "which copy is the player in" is two chances
 * to be 192 m out. This file's `recentre` and `worldOf` are the view layer's half of
 * the contract and nothing else defines it.
 */

/**
 * StreetView — everything you can see that is not the creature.
 *
 * @param {THREE.Scene} scene
 * @param {object} [options]
 * @param {number} [options.seed] the run seed; fixes the world for the run
 * @param {object} [options.objectives] from `placeObjectives`
 * @param {number} [options.loop] starting capture counter, for the fixture pass
 * @param {number} [options.portalRange] metres at which a portal is in reach
 * @param {number} [options.pickupRange] metres at which the hammer is in reach
 */
export class StreetView {
  constructor(scene, options = {}) {
    this.scene = scene
    this.seed = options.seed ?? 1337
    this.objectives = options.objectives ?? placeObjectives(this.seed, options.loop ?? 1)
    this.loop = options.loop ?? 1
    this.portalRange = options.portalRange ?? 2.6
    this.pickupRange = options.pickupRange ?? 1.5
    this.reserved = reservedLots(this.objectives)
    // §3.6's `reserved` covers the spawn clearance as well as the anchors, and the
    // two want different treatment here: a fixture-free lot may still have a house
    // on it, but a house on an anchor's lot would bury the objective. So the
    // anchor lots are tracked separately rather than inferred from `reserved`.
    this.anchorLots = new Set(this.objectives.all.map((anchor) => `${anchor.chunk.cx},${anchor.chunk.cz},${anchor.lot.side}`))

    // the whole neighbourhood hangs off one group so the wrap is a single
    // `position.set` on a multiple of WORLD_EXTENT
    this.group = new THREE.Group()
    this.group.name = 'street'
    this.scene.add(this.group)
    /** Which wrapped copy the world is currently drawn around, in world metres. */
    this.origin = { x: 0, z: 0 }

    // one canonical set of solids and one canonical set of sight blockers, both
    // in the folded copy; `recentre` and `applyLoop` mark them for recomposition
    // rather than translating anything in place
    this.staticColliders = []
    this.staticOccluders = []
    this.fixtureColliders = []
    this.fixtureOccluders = []
    this.colliderList = []
    this.occluderList = []
    this.fixtures = []
    /** Bumped whenever the collider set changes, so the world can skip a rebuild. */
    this.revision = 0
    this._dirty = true
    this.lampPositions = []
    this.pools = []
    this.textures = []
    this._time = 0

    this._materials = this._buildMaterials()
    this._buildRoad()
    this._buildChunkGeometry()
    this._buildFixturePools()
    this._buildPortals()
    this._buildHammer()
    this._buildExitCar()
    this.applyLoop(this.loop)
    this.recentre(0, 0)
  }

  // -------------------------------------------------------------------------
  // materials
  // -------------------------------------------------------------------------

  _texture(options) {
    const texture = makeSurfaceTexture(options)
    this.textures.push(texture)
    return texture
  }

  _material(options) {
    return new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0, ...options })
  }

  _glow(color, options = {}) {
    // unlit on purpose: a portal ring and a sodium lamp head are light sources,
    // not surfaces, and tone-mapping them as if they were lit would dim exactly
    // the two things §4 promises stay visible at distance
    return new THREE.MeshBasicMaterial({ color, fog: false, ...options })
  }

  _buildMaterials() {
    const asphalt = this._texture({ seed: SURFACE_SEEDS.asphalt, base: 0.52, contrast: 0.34, grain: 0.1, repeat: 180 })
    const sidewalk = this._texture({ seed: SURFACE_SEEDS.sidewalk, base: 0.58, contrast: 0.16, grain: 0.05, repeat: 96 })
    const siding = this._texture({ seed: SURFACE_SEEDS.siding, base: 0.6, contrast: 0.18, grain: 0.04, stripes: 8 })
    const hedge = this._texture({ size: 64, seed: SURFACE_SEEDS.hedge, base: 0.46, contrast: 0.44, grain: 0.16 })
    return {
      asphalt: this._material({ color: PALETTE.asphalt, map: asphalt }),
      sidewalk: this._material({ color: PALETTE.sidewalk, map: sidewalk }),
      kerb: this._material({ color: PALETTE.kerb }),
      yard: this._material({ color: PALETTE.yard }),
      siding: [
        this._material({ color: PALETTE.siding[0], map: siding }),
        this._material({ color: PALETTE.siding[1], map: siding }),
      ],
      roof: this._material({ color: PALETTE.roof }),
      hedge: this._material({ color: PALETTE.hedge, map: hedge }),
      fence: this._material({ color: PALETTE.fence }),
      metal: this._material({ color: 0x33303a, roughness: 0.6, metalness: 0.35 }),
      car: this._material({ color: PALETTE.carBody, roughness: 0.5, metalness: 0.25 }),
      glass: this._material({ color: 0x1b2026, roughness: 0.25, metalness: 0.5 }),
      shed: this._material({ color: 0x2d2a26 }),
      sodium: this._glow(PALETTE.sodium),
      // The pool the lamp throws on the road. Additive, unlit and depth-writing
      // nothing, because it is a light rather than a surface: the four point
      // lights `world.js` owns cannot cover a 49-lamp grid, so without this the
      // sodium family exists as 49 glowing heads over 49 pools of pure black
      // asphalt, and §12.1's "the streetlights have already come on" is a claim
      // the renderer never makes. `fog: true` here and `fog: false` on the head
      // above it is deliberate and is the whole depth cue: the pool fades with
      // distance, the lamp does not.
      sodiumPool: this._glow(PALETTE.sodium, {
        map: makePoolTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
      portal: this._glow(PALETTE.portal),
      // §12.2's cold family, given the ground the sodium family already gets.
      // The comment on `sodiumPool` below is the whole argument: a light source
      // with nothing underneath it is a glowing hoop over black tarmac. The
      // sodium lamps had 49 pools and four point lights between them, and the
      // comment explains that the pools are what make "the streetlights have
      // already come on" true rather than merely asserted. A portal had the ring,
      // a 9-intensity point light and no pool at all, which is the same failure
      // in its worst form — the one cold light in the game, reading as a decal on
      // a dark shed. Same additive plane and same falloff texture, cyan instead
      // of sodium, and a quarter of the diameter: a doorway is not a streetlight.
      portalPool: this._glow(PALETTE.portal, {
        map: makePoolTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
      portalDead: this._glow(PALETTE.portalDead),
      headlight: this._glow(PALETTE.headlight),
      windowLit: this._glow(0xffbe72),
      panel: this._material({ color: 0x26232b }),
    }
  }

  // -------------------------------------------------------------------------
  // roads — §3.5: streets are a graph on block boundaries, never obstructed
  // -------------------------------------------------------------------------

  /**
   * The carriageway, the kerbs and the walks, for all four directions at once.
   *
   * One plane and 56 instanced strips, each `RUN_LENGTH` long, rather than
   * geometry per block. The strips are three world periods long so a run of
   * pavement crosses the wrap seam without a join, which is the cheapest possible
   * proof that the seam is invisible from the ground as well as from above.
   */
  _buildRoad() {
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(RUN_LENGTH, RUN_LENGTH),
      this._materials.asphalt,
    )
    road.name = 'asphalt'
    road.rotation.x = -Math.PI / 2
    this.group.add(road)
    this.road = road

    const kerbs = this._pool('kerb', new THREE.BoxGeometry(1, 1, 1), this._materials.kerb, 4 * GRID + 8)
    const walks = this._pool('sidewalk', new THREE.BoxGeometry(1, 1, 1), this._materials.sidewalk, 4 * GRID + 8)
    const kerbOffset = STREET_HALF_WIDTH + KERB_WIDTH / 2
    const walkOffset = STREET_HALF_WIDTH + KERB_WIDTH + SIDEWALK_WIDTH / 2
    for (let axis = 0; axis < GRID; axis += 1) {
      const line = roadAxisToWorld(axis)
      for (const side of [-1, 1]) {
        // an avenue runs north-south, so its kerb and walk are long in z
        kerbs.place(line + side * kerbOffset, 0.075, 0, KERB_WIDTH, 0.15, RUN_LENGTH)
        walks.place(line + side * walkOffset, 0.07, 0, SIDEWALK_WIDTH, 0.14, RUN_LENGTH)
        // a street runs east-west, so the same two strips are rotated in effect
        kerbs.place(0, 0.075, line + side * kerbOffset, RUN_LENGTH, 0.15, KERB_WIDTH)
        walks.place(0, 0.07, line + side * walkOffset, RUN_LENGTH, 0.14, SIDEWALK_WIDTH)
      }
    }
    kerbs.commit()
    walks.commit()
  }

  // -------------------------------------------------------------------------
  // chunks — §3.2 random access, §3.3 the wrap, §3.5 lots
  // -------------------------------------------------------------------------

  _pool(name, geometry, material, capacity) {
    const pool = new InstancePool(geometry, material, capacity, name)
    this.pools.push(pool)
    this.group.add(pool.mesh)
    return pool
  }

  /** Instance capacity for anything placed once per lot, per wrapped copy. */
  static get LOT_CAPACITY() {
    return CHUNKS * SIDE_NAMES.length * WRAP_COPIES.length
  }

  /** Canonical in-order chunk list — the order the checks compare against. */
  static chunkOrder() {
    const coords = []
    for (let cx = 0; cx < GRID; cx += 1) {
      for (let cz = 0; cz < GRID; cz += 1) coords.push({ cx, cz })
    }
    return coords
  }

  /**
   * Every lot of every chunk, three times over.
   *
   * The order the chunks are visited in is a parameter, not a fact: each chunk's
   * geometry is derived from `chunkAt(seed, cx, cz)` alone, so visiting them
   * shuffled produces the same set of matrices with different instance indices.
   * That is the streaming contract of §3.2, and it is why `buildChunks` is a
   * public method instead of a loop buried in the constructor.
   *
   * @param {Array<{cx: number, cz: number}>} [order] chunk coordinates to visit
   */
  buildChunks(order) {
    const coords = order ?? StreetView.chunkOrder()
    for (const { cx, cz } of coords) this._addChunk(chunkAt(this.seed, cx, cz))
  }

  _buildChunkGeometry() {
    const lot = StreetView.LOT_CAPACITY
    this.pools.yards = this._pool('yard', new THREE.BoxGeometry(1, 1, 1), this._materials.yard, lot + 8)
    this.pools.houses = this._pool('house', new THREE.BoxGeometry(1, 1, 1), this._materials.siding[0], lot)
    this.pools.roofs = this._pool('roof', new THREE.ConeGeometry(0.72, 1, 4), this._materials.roof, lot)
    this.pools.outbuildings = this._pool('outbuilding', new THREE.BoxGeometry(1, 1, 1), this._materials.shed, lot)
    this.pools.frontage = this._pool('frontage', new THREE.BoxGeometry(1, 1, 1), this._materials.hedge, lot * 2 + 8)
    this.pools.lampPosts = this._pool('lampPost', new THREE.CylinderGeometry(0.09, 0.12, 1, 6), this._materials.metal, CHUNKS * WRAP_COPIES.length + 8)
    this.pools.lampHeads = this._pool('lampHead', new THREE.BoxGeometry(1, 1, 1), this._materials.sodium, CHUNKS * WRAP_COPIES.length + 8)
    // The pools lie on the road, so their geometry is pre-rotated flat rather than
    // given a rotation: `InstancePool.place` composes yaw only, and a pool is
    // radially symmetric, so yaw is the one transform it does not need.
    this.pools.lampPools = this._pool(
      'lampPool',
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      this._materials.sodiumPool,
      CHUNKS * WRAP_COPIES.length + 8,
    )
    this.buildChunks()
    // The lamps are built *before* the commit loop, and that order is the whole
    // reason this call is here rather than after it. `InstancePool.commit()` is
    // the only thing that publishes instances: it sets `mesh.count` and flags
    // `instanceMatrix` for upload. Filling a pool after its commit places 147
    // lamp posts and 147 lamp heads into a buffer that is never uploaded and
    // never counted, which is not a subtle shading problem — it is a street with
    // no streetlights on it at all, and the only reason it read as "a dark
    // scene" rather than "a bug" is that the four dynamic point lights
    // `world.js` aims at `lampPositions` still work, because those come from the
    // data rather than the geometry.
    this._buildLamps()
    for (const name of ['yards', 'houses', 'roofs', 'outbuildings', 'frontage', 'lampPosts', 'lampHeads', 'lampPools']) {
      this.pools[name].commit()
    }
  }

  /**
   * One chunk: its four lots, each drawn in all three wrapped copies.
   *
   * The five anchor lots get no house. §3.6's rule 2 protects the *point* an
   * objective sits on, and a 5 m house dropped on top of that point would satisfy
   * the letter of it and destroy the thing it exists for. The frontage still goes
   * in, gap and all, because the approach corridor has to arrive somewhere.
   *
   * The spawn clearance lots keep theirs. Rule 2 clears them of *fixtures* — the
   * player must not wake up inside a car — and a house is not a fixture, and
   * nine bald blocks around the spawn would read as a bomb crater rather than a
   * corner.
   */
  _addChunk(chunk) {
    for (const lot of chunk.lots) {
      const isAnchor = this.anchorLots.has(`${chunk.cx},${chunk.cz},${lot.side}`)
      for (const copy of WRAP_COPIES) {
        this._addLot(chunk, lot, isAnchor, copy)
      }
    }
  }

  _addLot(chunk, lot, isAnchor, copy) {
    const frame = lotFrame(lot)
    const x = lot.x + copy * WORLD_EXTENT
    const z = lot.z + copy * WORLD_EXTENT
    const tint = lot.tint % PALETTE.siding.length

    // the lot's own ground: a yard slab, so a driveway reads as a driveway.
    // `YARD_TOP - 0.1` is the same 0.1 the slab is thick, written so the apron's
    // `YARD_TOP` and this placement cannot drift apart into a buried decal
    this.pools.yards.place(x, YARD_TOP - 0.1, z, frame.long, 0.1, frame.short)

    if (!isAnchor) {
      const wall = lot.kind === 'house' ? WALL_HEIGHT : lot.kind === 'garage' ? 2.7 : 2.2
      const depth = frame.short * (lot.kind === 'house' ? 0.55 : 0.5)
      const width = frame.long * (lot.kind === 'house' ? 0.7 : lot.kind === 'garage' ? 0.34 : 0.2)
      const centre = atDepth(frame, frame.short - depth, depth)
      const cx = frame.alongX ? x : x + (centre - lot.x)
      const cz = frame.alongX ? z + (centre - lot.z) : z
      const w = frame.alongX ? width : depth
      const d = frame.alongX ? depth : width
      if (lot.kind === 'house') {
        // the two-tone siding of §12.3 is per-lot deterministic: `tint` comes from
        // the chunk's own stream, so a block's houses agree with each other and
        // two blocks differ, which is most of what "a repeating neighbourhood"
        // has to mean for it to read as one
        this.pools.houses.mesh.material = this._materials.siding[tint]
        this.pools.houses.place(cx, wall / 2, cz, w, wall, d)
        this.pools.roofs.place(cx, wall + ROOF_HEIGHT / 2, cz, w * 1.06, ROOF_HEIGHT, d * 1.06, Math.PI / 4)
      } else {
        this.pools.outbuildings.place(cx, wall / 2, cz, w, wall, d)
      }
      // one copy only: the wrapped copies exist to be seen, not collided with,
      // and the player is always within half a period of the canonical one
      if (copy === 0) {
        this._collider(cx, cz, w, d, lot.kind)
        this._occluder(cx, cz, w, d, lot.kind)
      }
    }

    // the frontage: two hedge or fence runs with the driveway gap between them.
    // The gap IS the approach (§3.6 rule 3), so it is sized off the lot's own
    // geometry rather than typed, and the middle third of every lot stays open.
    const segment = frame.long / 3 - 1.5
    const offset = frame.long / 3
    const kind = (chunk.cx + chunk.cz + SIDE_NAMES.indexOf(lot.side)) % 2 === 0 ? 'hedge' : 'fence'
    this.pools.frontage.mesh.material = kind === 'hedge' ? this._materials.hedge : this._materials.fence
    for (const side of [-1, 1]) {
      const sx = frame.alongX ? x + side * offset : x + (frame.front - lot.x)
      const sz = frame.alongX ? z + (frame.front - lot.z) : z + side * offset
      const w = frame.alongX ? segment : 0.5
      const d = frame.alongX ? 0.5 : segment
      const h = kind === 'hedge' ? 1.3 : 1.1
      this.pools.frontage.place(sx, h / 2, sz, w, h, d)
      if (copy === 0) {
        this._collider(sx, sz, w, d, kind)
        this._occluder(sx, sz, w, d, kind)
      }
    }
  }

  /**
   * One sodium lamp per intersection, on the corner of the pavement.
   *
   * 49 lamps 64 m apart is a real streetlight spacing rather than a decorative
   * one, and it is what makes §12.1's "the streetlights have already come on"
   * legible: the pools of light are a landmark grid, so they have to be regular
   * enough to steer by and sparse enough that the fog still has work to do between
   * them.
   */
  _buildLamps() {
    this.lampPositions = []
    for (let ax = 0; ax < GRID; ax += 1) {
      for (let az = 0; az < GRID; az += 1) {
        const node = streetNodeToWorld(ax * GRID + az)
        const lx = node.x + STREET_HALF_WIDTH + 1.6
        const lz = node.z + STREET_HALF_WIDTH + 1.6
        for (const copy of WRAP_COPIES) {
          this.pools.lampPosts.place(lx + copy * WORLD_EXTENT, 2.6, lz + copy * WORLD_EXTENT, 1, 5.2, 1)
          this.pools.lampHeads.place(lx - 0.9 + copy * WORLD_EXTENT, 5.1, lz + copy * WORLD_EXTENT, 1.9, 0.18, 0.34)
          // The pool sits under the head rather than the post, and reaches the
          // kerbs and stops. `place` scales the pre-rotated plane by (x, z), so
          // both numbers below are the same diameter.
          this.pools.lampPools.place(
            lx - 0.9 + copy * WORLD_EXTENT,
            0.03,
            lz + copy * WORLD_EXTENT,
            LAMP_POOL_DIAMETER,
            1,
            LAMP_POOL_DIAMETER,
          )
        }
        // one canonical record per lamp, for the light pool `world.js` drives
        this.lampPositions.push({ x: lx, z: lz })
      }
    }
  }

  // -------------------------------------------------------------------------
  // the objectives — §5.1 portals, §7.1 hammer, §10.3 exit
  // -------------------------------------------------------------------------

  _box(w, h, d, material, x, y, z, yaw = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
    mesh.position.set(x, y, z)
    mesh.rotation.y = yaw
    return mesh
  }

  /**
   * The three portals, one per district, each in its own liminal structure.
   *
   * §5.1 names the three: a shed, a bus shelter, a phone box. They are built from
   * the same box primitive at three scales because the whole point of the list is
   * that they read as *different kinds of place* from the outside — a player who
   * has learned to recognise the phone box is steering by a memory (§4's portal
   * glow), and a silhouette that is the same shed three times teaches nothing.
   */
  _buildPortals() {
    this.portals = PORTAL_IDS.map((id, index) => {
      const anchor = this.objectives.portals[index]
      const frame = lotFrame(anchor.lot)
      const root = new THREE.Group()
      root.name = `portal-${id}`
      root.position.set(anchor.position.x, 0, anchor.position.z)
      root.rotation.y = frame.yaw
      const shell = new THREE.Group()
      if (index === 0) {
        // Shed: a back wall, two side walls, and a +X flank built as TWO panels
        // with a gap between them — the doorway the ring stands in.
        //
        // The gap is the whole point of this structure and it was missing. The
        // +X flank used to be one box 2.4 m deep, which is exactly the full
        // depth of the shed, so the panel sealed the opening it was named for
        // and the §16.5.5 view photographed a closed black box with the ring
        // sealed inside it. The apron on the ground and the light around the
        // roofline still measured, so the luma gate passed a picture of a wall:
        // the gate measures how much light is in the frame, not whether the
        // frame is of the thing it claims to be.
        //
        // 1.3 m of the 2.4 m flank is wall, 1.1 m is the doorway, and the ring
        // (1.56 m across at 0.78 m radius) is sized to be *wider* than the
        // opening — so from outside you see the cyan rim of a ring the doorway
        // is cropping, which is what a ring in a doorway actually looks like.
        shell.add(this._box(3.2, 2.4, 0.18, this._materials.shed, 0, 1.2, -1.3))
        shell.add(this._box(0.18, 2.4, 2.4, this._materials.shed, -1.5, 1.2, 0))
        // the two flank panels, each 0.65 m deep, leaving z in (-0.65, 0.65) open
        shell.add(this._box(0.9, 2.4, 0.65, this._materials.shed, 1.25, 1.2, -0.975))
        shell.add(this._box(0.9, 2.4, 0.65, this._materials.shed, 1.25, 1.2, 0.975))
        // a lintel over the opening, so the doorway reads as a built opening
        // rather than a missing wall, and the gap is not a hole in the shed
        shell.add(this._box(0.9, 0.5, 1.3, this._materials.shed, 1.25, 2.15, 0))
        shell.add(this._box(3.6, 0.16, 3.0, this._materials.roof, 0, 2.5, 0))
      } else if (index === 1) {
        // bus shelter: a back panel, a roof on two posts, and nothing else
        shell.add(this._box(3.8, 2.2, 0.16, this._materials.glass, 0, 1.4, -0.7))
        shell.add(this._box(4.2, 0.18, 1.8, this._materials.metal, 0, 2.6, 0))
        shell.add(this._box(0.14, 2.6, 0.14, this._materials.metal, -1.9, 1.3, 0.5))
        shell.add(this._box(0.14, 2.6, 0.14, this._materials.metal, 1.9, 1.3, 0.5))
        shell.add(this._box(3.4, 0.12, 0.5, this._materials.metal, 0, 0.6, -0.4))
      } else {
        // phone box: a lit-glass cube on a plinth, the most enclosed of the three
        shell.add(this._box(1.1, 2.4, 1.1, this._materials.metal, 0, 1.2, 0))
        shell.add(this._box(1.24, 0.14, 1.24, this._materials.roof, 0, 2.46, 0))
        shell.add(this._box(0.9, 1.5, 0.06, this._materials.glass, 0, 1.5, -0.58))
      }
      root.add(shell)

      // The ring: §12.2's only cold light, standing in the doorway of each shell.
      //
      // Turned to face out of the opening, which is not a detail. A
      // `TorusGeometry` lies in the XY plane and so is seen edge-on — as a thin
      // vertical bar, not a ring — by any camera looking down its own Z axis.
      // The shed opens on its +X flank, so a ring left unrotated is viewed
      // side-on by exactly the camera `capture.js` places on the shed's `facing`
      // side, and §16.5.5 photographed a cyan stick. `PORTAL_OPEN_AXIS` already
      // records which way each shell opens, so the quarter-turn that brings the
      // ring's face toward the opening is read from that table rather than
      // hardcoded per structure.
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.78, 0.08, 10, 28),
        this._materials.portal.clone(),
      )
      ring.position.set(0, 1.35, 0)
      // a quarter turn about Y, for the shells that open on X
      if (PORTAL_OPEN_AXIS[index] === 'x') ring.rotation.y = Math.PI / 2
      ring.name = `portal-ring-${id}`
      root.add(ring)

      const light = new THREE.PointLight(PALETTE.portal, 9, 26, 2)
      light.position.set(0, 1.5, 0)
      root.add(light)

      // The apron the ring throws on the ground, and the reason the portal views
      // have anything in the bottom half of the frame to measure. Pre-rotated
      // flat for the same reason the sodium pools are: `place` composes yaw only
      // and a radial falloff needs nothing else. A cloned material rather than
      // the shared one, so `setPortalShut` can put this portal's apron out
      // individually — three portals sharing one material could not be shut one
      // at a time, which is the entire rule of §5.3.
      //
      // The height is 0.13 and not the sodium pools' 0.03, and that difference is
      // the whole bug this had on its first run: a portal stands in a *lot*, and
      // a lot's ground is a yard slab 0.1 m thick with its top face at 0.1, so an
      // apron laid at 0.03 is inside the slab and renders nothing. It measured
      // 0.33% lit — the sodium value, apparently, and no cyan in it at all. The
      // pools clear their own surface by 0.03; this clears the yard by the same.
      const apron = new THREE.Mesh(
        new THREE.PlaneGeometry(PORTAL_APRON_DIAMETER, PORTAL_APRON_DIAMETER).rotateX(-Math.PI / 2),
        this._materials.portalPool.clone(),
      )
      apron.position.set(0, YARD_TOP + 0.03, 0)
      root.add(apron)

      this.group.add(root)
      // The direction out of the opening, in world space, so a camera can be put
      // on the side the portal is actually readable from. `root.rotation.y` is
      // `frame.yaw`, and rotating a local axis by it about Y gives local +X ->
      // (cos, -sin) and local +Z -> (sin, cos). Stored as a unit vector rather
      // than a yaw because a stand-off is a direction and a distance, and every
      // caller wants exactly that.
      const sin = Math.sin(frame.yaw)
      const cos = Math.cos(frame.yaw)
      const facing = PORTAL_OPEN_AXIS[index] === 'x' ? { x: cos, z: -sin } : { x: sin, z: cos }
      const portal = {
        id,
        anchor,
        structure: PORTAL_STRUCTURES[index],
        root,
        ring,
        light,
        apron,
        facing,
        shut: false,
        position: { x: anchor.position.x, z: anchor.position.z },
      }
      this._collider(anchor.position.x, anchor.position.z, 2.4, 2.0, 'structure')
      this._occluder(anchor.position.x, anchor.position.z, 2.4, 2.0, 'structure')
      return portal
    })
  }

  /**
   * The hammer (§7.1) — the only object in the world that is also an event.
   *
   * §12.2's two light families do not cover it, so it is deliberately neither:
   * a warm brass body with a faint amber pool around it, sitting in the open on
   * its lot with nothing else lit. It is a *find*, and the design says so by
   * making it the only object in the game that glows without being a lamp.
   */
  _buildHammer() {
    const anchor = this.objectives.hammer
    const root = new THREE.Group()
    root.name = 'hammer'
    root.position.set(anchor.position.x, 0, anchor.position.z)
    const brass = this._material({ color: 0x8a6f3c, roughness: 0.45, metalness: 0.6 })
    const shaft = this._box(0.07, 0.62, 0.07, brass, 0, 1.02, 0)
    const head = this._box(0.34, 0.15, 0.15, brass, 0, 1.36, 0)
    const collar = this._box(0.12, 0.1, 0.12, this._materials.metal, 0, 0.72, 0)
    root.add(shaft, head, collar)
    const light = new THREE.PointLight(0xffc46a, 3.2, 12, 2)
    light.position.set(0, 1.2, 0)
    root.add(light)
    this.group.add(root)
    this.hammer = { anchor, root, light, taken: false, position: { x: anchor.position.x, z: anchor.position.z } }
  }

  /**
   * The exit car (§10.3) — present, dark, and easy to walk past.
   *
   * The whole finale rests on this object, and one detail decides whether the
   * finale is a destination or a coin flip: the car is parked *beside* its
   * anchor, never on it. `isInsideExit` is a 1.15 m radius test around the anchor
   * and the player's own collision radius is 0.36 m, so a car body centred on the
   * anchor would make the win condition geometrically unreachable — the player
   * would be pushed out of their own win trigger. Two and a half metres of
   * kerbside offset puts the anchor at the open driver's door instead.
   */
  _buildExitCar() {
    const anchor = this.objectives.exit
    const frame = lotFrame(anchor.lot)
    const root = new THREE.Group()
    root.name = 'exit-car'
    const along = frame.alongX ? { x: 1, z: 0 } : { x: 0, z: 1 }
    const centre = { x: anchor.position.x + along.x * 2.6, z: anchor.position.z + along.z * 2.6 }
    root.position.set(centre.x, 0, centre.z)
    // nose to the street: the yaw whose local -Z faces the frontage, so the
    // headlights throw their beam at the pavement the player arrives on
    root.rotation.y = frame.yaw
    const length = frame.alongX ? 4.2 : 1.85
    const width = frame.alongX ? 1.85 : 4.2
    root.add(this._box(length, 0.82, width, this._materials.car, 0, 0.62, 0))
    root.add(this._box(length * 0.5, 0.6, width * 0.92, this._materials.glass, -length * 0.05, 1.3, 0))
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        root.add(
          this._box(
            frame.alongX ? 0.7 : 0.24,
            0.66,
            frame.alongX ? 0.24 : 0.7,
            this._materials.metal,
            sx * length * 0.31,
            0.33,
            sz * width * 0.42,
          ),
        )
      }
    }
    // the headlights, pointing back at the street the player arrives from
    const lamps = []
    for (const side of [-1, 1]) {
      const lamp = this._box(0.16, 0.2, 0.42, this._materials.headlight.clone(), 0, 0, 0)
      lamp.position.set(frame.alongX ? length * 0.5 : side * width * 0.32, 0.72, frame.alongX ? side * width * 0.32 : length * 0.5)
      lamp.visible = false
      root.add(lamp)
      lamps.push(lamp)
    }
    const beam = new THREE.PointLight(PALETTE.headlight, 0, 34, 2)
    beam.position.set(frame.alongX ? length * 0.8 : 0, 1.1, frame.alongX ? 0 : length * 0.8)
    root.add(beam)
    this.group.add(root)
    this.exitCar = { anchor, root, lamps, beam, lit: false, centre, position: { x: anchor.position.x, z: anchor.position.z } }
    this._collider(centre.x, centre.z, length + 0.3, width + 0.2, 'car')
  }

  // -------------------------------------------------------------------------
  // fixtures — §3.6: per-loop, per-chunk, and a discrete event at reset
  // -------------------------------------------------------------------------

  /**
   * One pool per fixture kind, so a hedge is a long box and a cone is a cone.
   *
   * Capacity is derived from the generator's own bounds — 49 chunks x 4 lots x 3
   * slots x `FIXTURE_DENSITY`, split across two classes and five kinds, with
   * headroom for an unlucky seed — rather than typed, so a change to
   * `FIXTURE_DENSITY` cannot silently overflow a pool into a hole in the world.
   */
  _buildFixturePools() {
    const expected = CHUNKS * 4 * 3 * FIXTURE_DENSITY * 0.5 * 0.2
    const capacity = Math.ceil(expected * 3) + 32
    this.fixturePools = {}
    const geometryFor = (kind) => (kind === 'cone' ? new THREE.ConeGeometry(0.3, 1, 8) : new THREE.BoxGeometry(1, 1, 1))
    const materialFor = (kind) => {
      if (kind === 'hedge') return this._materials.hedge
      if (kind === 'fence') return this._materials.fence
      if (kind === 'car') return this._materials.car
      if (kind === 'shed') return this._materials.shed
      if (kind === 'bin') return this._materials.metal
      if (kind === 'window') return this._materials.windowLit
      if (kind === 'porchLight') return this._materials.sodium
      if (kind === 'cone') return this._material({ color: 0xa8552a })
      return this._materials.metal
    }
    for (const spec of [...STRUCTURAL_KINDS, ...DECORATIVE_KINDS]) {
      const pool = this._pool(`fixture-${spec.kind}`, geometryFor(spec.kind), materialFor(spec.kind), capacity)
      this.fixturePools[spec.kind] = pool
    }
  }

  /**
   * applyLoop — the per-loop fixture pass, and the collider rebuild with it.
   *
   * §3.6 calls this "a discrete event at reset rather than a per-frame cost", and
   * the split in this file is what makes that true: streets, lots and the
   * objective anchors are built once and never touched again, and everything that
   * churns lives in the fixture pools whose matrices are simply rewritten here.
   * A capture therefore permutes the world's dressing without moving a single
   * street, which is the entire "reshuffle on reset" decision from the log.
   *
   * @param {number} loopNumber 1-based
   * @returns {object[]} this loop's fixtures, in canonical coordinates
   */
  applyLoop(loopNumber) {
    this.loop = loopNumber
    const fixtures = []
    for (let cx = 0; cx < GRID; cx += 1) {
      for (let cz = 0; cz < GRID; cz += 1) fixtures.push(...chunkFixtures(this.seed, loopNumber, cx, cz, this.reserved))
    }
    for (const pool of Object.values(this.fixturePools)) pool.clear()
    // one `chunkAt` per chunk rather than one per fixture: the fixture pass emits
    // ~350 entries and a capture is a discrete event, but it should not be nine
    // times more expensive than it needs to be
    const lots = new Map()
    for (const fixture of fixtures) {
      const key = `${fixture.chunk.cx},${fixture.chunk.cz}`
      if (!lots.has(key)) lots.set(key, chunkAt(this.seed, fixture.chunk.cx, fixture.chunk.cz).lots)
      const lot = lots.get(key).find((entry) => entry.side === fixture.lot)
      for (const copy of WRAP_COPIES) {
        this._addFixture(fixture, lot, copy)
      }
    }
    for (const pool of Object.values(this.fixturePools)) pool.commit()
    this.fixtures = fixtures
    this.fixtureColliders = fixtures
      .filter((fixture) => fixture.collides)
      .map((fixture) => ({
        cx: fixture.x,
        cz: fixture.z,
        hx: fixture.w / 2,
        hz: fixture.d / 2,
        kind: fixture.kind,
      }))
    // §6.3: a structural fixture that is not a car or a bin blocks a sightline,
    // and the set of kinds that do is `creature.js`'s, not this file's
    this.fixtureOccluders = fixtures
      .filter((fixture) => fixture.collides && OCCLUDER_KINDS.includes(fixture.kind))
      .map((fixture) => ({ x: fixture.x, z: fixture.z, w: fixture.w, d: fixture.d, kind: fixture.kind }))
    this._dirty = true
    this.revision += 1
    return fixtures
  }

  /**
   * One fixture, three wrapped copies.
   *
   * `window` and `porchLight` are the kinds that decorate rather than occupy
   * ground, so they are placed against the house's front wall instead of on the
   * slot itself. The slot still decides which third of the wall they go on, so
   * the fixture pass keeps its say over the layout; only the depth is borrowed
   * from the lot. Floating panels in a yard would have read as a bug.
   */
  _addFixture(fixture, lot, copy) {
    const pool = this.fixturePools[fixture.kind]
    if (!pool) return
    const shape = FIXTURE_SHAPES[fixture.kind] ?? { h: 1, lift: 0 }
    const x = fixture.x + copy * WORLD_EXTENT
    const z = fixture.z + copy * WORLD_EXTENT
    if (fixture.kind === 'window' || fixture.kind === 'porchLight') {
      if (!lot) return
      const frame = lotFrame(lot)
      const face = atDepth(frame, frame.short - frame.short * 0.55, 0)
      const sign = frame.back >= frame.front ? 1 : -1
      // the wall is canonical, so the panel has to be carried into the copy with
      // everything else — otherwise the ±1 copies' windows all pile up on the
      // canonical block and the far side of the wrap lights up for no reason
      const proud = face + copy * WORLD_EXTENT - sign * 0.08
      const panel = fixture.kind === 'window' ? 1.1 : 0.3
      if (frame.alongX) pool.place(x, shape.lift, proud, panel, shape.h, 0.1)
      else pool.place(proud, shape.lift, z, 0.1, shape.h, panel)
      return
    }
    pool.place(x, shape.lift + shape.h / 2, z, fixture.w, shape.h, fixture.d)
  }

  // -------------------------------------------------------------------------
  // collision + sight — one canonical list, translated by the wrap origin
  // -------------------------------------------------------------------------

  _collider(cx, cz, w, d, kind) {
    this.staticColliders.push({ cx, cz, hx: w / 2, hz: d / 2, kind })
  }

  _occluder(cx, cz, w, d, kind) {
    this.staticOccluders.push({ x: cx, z: cz, w, d, kind })
  }

  /**
   * recentre — snap the world to the wrapped copy the player is standing in.
   *
   * The player never wraps; the world does, in whole periods, and only ever
   * behind them. `originFor` is what makes that true in both directions: at
   * x = -230 the nearest copy is -448, and at x = +230 it is +448, so walking off
   * the eastern edge and off the western edge put the player in the same
   * neighbourhood the same way round. A floor would leave the west edge one period
   * further out than the east, and the seam would be visible in exactly one
   * direction — which is the bug the manual check for this slice is looking for.
   *
   * @returns {boolean} true when the world moved, i.e. colliders need refreshing
   */
  recentre(x, z) {
    const ox = originFor(x)
    const oz = originFor(z)
    if (ox === this.origin.x && oz === this.origin.z) return false
    this.origin = { x: ox, z: oz }
    this.group.position.set(ox, 0, oz)
    this._dirty = true
    this.revision += 1
    return true
  }

  /**
   * A canonical anchor's position in the copy currently drawn around the player.
   *
   * The optional second argument is the point to fold around, for callers that are
   * *deciding* something about the world rather than reading where it is — see
   * `worldOfNear` for why that is a different question, and for the case where the
   * difference is the bug.
   */
  worldOf(position, near) {
    if (!near) return { x: position.x + this.origin.x, z: position.z + this.origin.z }
    return this.worldOfNear(position, near)
  }

  /**
   * worldOfNear — the same fold, into the copy that would be drawn around *this*
   * point rather than the one drawn around the player.
   *
   * `worldOf` answers "where does the player see this anchor?", and that is the
   * right question everywhere except when the caller is deciding where to *put*
   * something: a placement is a question about the world as it will be, not as it
   * currently is. Folding against a stale `origin` is how slice 14 found §6.1's
   * first sighting landing on top of the player — the player had walked two
   * periods east, so "the node in your view cone" was measured from the wrong
   * copy of the map and the cone came back empty.
   *
   * Non-mutating on purpose: asking where a thing would be is not the same as
   * moving the world there, and a placement query that slides the street under
   * the player would be a much worse bug than the one it fixed.
   *
   * @param {{x: number, z: number}} position canonical
   * @param {{x: number, z: number}} near the point to fold around
   * @returns {{x: number, z: number}} folded
   */
  worldOfNear(position, near) {
    return { x: position.x + originFor(near.x), z: position.z + originFor(near.z) }
  }

  _compose() {
    const { x, z } = this.origin
    const colliders = []
    const occluders = []
    for (const box of this.staticColliders) colliders.push({ cx: box.cx + x, cz: box.cz + z, hx: box.hx, hz: box.hz })
    for (const box of this.fixtureColliders) colliders.push({ cx: box.cx + x, cz: box.cz + z, hx: box.hx, hz: box.hz })
    for (const rect of this.staticOccluders) occluders.push({ x: rect.x + x, z: rect.z + z, w: rect.w, d: rect.d, kind: rect.kind })
    for (const rect of this.fixtureOccluders) occluders.push({ x: rect.x + x, z: rect.z + z, w: rect.w, d: rect.d, kind: rect.kind })
    this.colliderList = colliders
    this.occluderList = occluders
    this._dirty = false
  }

  /** Every solid in the copy the player is in, in `PlayerController.setColliders` shape. */
  colliders() {
    if (this._dirty) this._compose()
    return this.colliderList
  }

  /**
   * Everything that blocks a sightline, for `creature.js`'s §6.3 and §8.3.
   *
   * The kinds are `creature.js`'s `OCCLUDER_KINDS` — houses, garages, sheds,
   * hedges, fences — plus the three portal shells, which block sight in the world
   * and would be lies in the AI if they did not block it in `canSee` too.
   */
  occluders() {
    if (this._dirty) this._compose()
    return this.occluderList
  }

  /**
   * Everything that blocks a sightline, in the *folded* frame, for `world.js`.
   *
   * The distinction from `occluders()` is the same one the collider list draws
   * and it exists for the same reason: the creature's own position is canonical
   * (`reemergeNode` and `streetNodeToWorld` both speak the folded frame), so the
   * rects its sight tests run against have to be in that frame too. The world's
   * distance to the player goes through `creature.js`'s `wrapDelta` instead, which
   * is the seam §3.3's fold leaves open on purpose.
   */
  canonicalOccluders() {
    return [...this.staticOccluders, ...this.fixtureOccluders]
  }

  /** The nearest lamps, in world space, for the point-light pool `world.js` owns. */
  lampsNear(x, z, radius) {
    const found = []
    for (const lamp of this.lampPositions) {
      const world = this.worldOf(lamp)
      const distance = Math.hypot(world.x - x, world.z - z)
      if (distance <= radius) found.push({ x: world.x, y: 5.1, z: world.z, distance })
    }
    found.sort((a, b) => a.distance - b.distance)
    return found
  }

  // -------------------------------------------------------------------------
  // what the world asks about
  // -------------------------------------------------------------------------

  /**
   * The portal in reach, if any (§5.2's hold verb needs a target).
   *
   * Distance is measured against the *copy the player is standing in*, not the
   * canonical anchor — the same distinction the collider list makes, for the same
   * reason: a portal 448 m away around the torus is the portal you are standing
   * next to.
   */
  nearestPortal(position) {
    let best = null
    for (const portal of this.portals) {
      const world = this.worldOf(portal.position)
      const distance = Math.hypot(position.x - world.x, position.z - world.z)
      if (distance > this.portalRange) continue
      if (best && best.distance <= distance) continue
      best = { id: portal.id, portal, position: world, distance }
    }
    return best
  }

  /** The hammer in reach, if it has not been picked up. */
  nearestHammer(position) {
    if (this.hammer.taken) return null
    const world = this.worldOf(this.hammer.position)
    const distance = Math.hypot(position.x - world.x, position.z - world.z)
    if (distance > this.pickupRange) return null
    return { hammer: this.hammer, position: world, distance }
  }

  // -------------------------------------------------------------------------
  // state the world drives in
  // -------------------------------------------------------------------------

  /**
   * setPortalShut — §5.4's permanent record of progress.
   *
   * A shut portal stays dark for the rest of the run, across every capture, so
   * this is a one-way door with no counterpart anywhere else in the codebase. That
   * asymmetry is the point: §5.3 calls it "the single most important rule in the
   * original design", and a view layer that could un-light one would quietly undo
   * the only promise the run makes to the player.
   */
  setPortalShut(id, shut = true) {
    const portal = this.portals.find((entry) => entry.id === id)
    if (!portal) return false
    portal.shut = shut
    portal.ring.material = shut ? this._materials.portalDead : this._materials.portal
    portal.light.intensity = shut ? 0 : 9
    portal.light.visible = !shut
    // and the apron with them, in the same breath and for the same reason: a
    // shut portal that kept a cyan pool on the ground would be advertising an
    // objective the run has already spent
    portal.apron.visible = !shut
    return true
  }

  setHammerTaken(taken = true) {
    this.hammer.taken = taken
    this.hammer.root.visible = !taken
    this.hammer.light.visible = !taken
  }

  /**
   * setHeadlights — §10.3.
   *
   * The car is dark and unremarkable from Act I, and this is the only thing that
   * changes. It is a method rather than a derived property because the trigger is
   * slice 13's finale, and because an assertion like "the car does nothing until
   * asked" is only possible if something has to ask.
   */
  setHeadlights(on) {
    this.exitCar.lit = on === true
    for (const lamp of this.exitCar.lamps) lamp.visible = this.exitCar.lit
    this.exitCar.beam.intensity = this.exitCar.lit ? 26 : 0
  }

  /**
   * update — the two light families breathing.
   *
   * Sodium flicker sits on the shared lamp material, so all 49 lamps gutter
   * together, which is how a real grid behaves and is cheaper than per-instance
   * variation. The portal pulse is the cold family's tell: a slow swell visible
   * through a gap between two houses long before the player can see the ring
   * itself, which is §4's second navigation mechanism doing its job.
   */
  update(dt) {
    this._time += dt
    const t = this._time
    const flicker = 0.88 + (Math.sin(t * 7.3) + Math.sin(t * 2.9 + 1.1) + Math.sin(t * 17.7)) * 0.04
    this._materials.sodium.color.setHex(PALETTE.sodium).multiplyScalar(flicker)
    // The pool gutters with the head above it. They share one grid on purpose, and
    // a pool that stayed steady under a guttering lamp would be the one thing in
    // the sodium family giving the flicker away.
    this._materials.sodiumPool.color.setHex(PALETTE.sodium).multiplyScalar(flicker)
    const pulse = 0.86 + Math.sin(t * 1.9) * 0.1 + Math.sin(t * 0.61) * 0.04
    for (const portal of this.portals) {
      if (portal.shut) continue
      portal.light.intensity = 9 * pulse
      const swell = 1 + Math.sin(t * 2.3) * 0.035
      portal.ring.scale.set(swell, swell, swell)
    }
    if (!this.hammer.taken) {
      this.hammer.light.intensity = 3.2 * pulse
      this.hammer.root.rotation.y = t * 0.35
    }
  }

  dispose() {
    this.scene.remove(this.group)
    for (const pool of this.pools) pool.dispose()
    for (const texture of this.textures) texture.dispose()
    for (const material of Object.values(this._materials)) {
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material.dispose()
    }
    this.pools = []
    this.textures = []
  }
}

export default StreetView
