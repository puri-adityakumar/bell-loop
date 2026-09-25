/**
 * neighborhood.js — the chunk-addressable world for THE LONG QUIET (v2, slice 02).
 *
 * THE WORLD
 * ---------
 * A 7 x 7 grid of city blocks that wraps toroidally (GAMEDESIGN.md §3.1). There
 * are 7 north-south avenues and 7 east-west streets, crossing at 49
 * intersections. Block (cx, cz) is the lot between avenue `cx`/`cx+1` and street
 * `cz`/`cz+1`, and its four corners are four of those intersections. The whole
 * thing is a 49-node, 98-edge grid graph on a torus.
 *
 * WHY THE WRAP IS JUST A FOLD
 * ---------------------------
 * `resolveChunk` is a coordinate transform, not a special case inside the
 * generator (§3.3). When streaming arrives it stops folding and nothing else
 * changes — which is the whole reason the generator was built random-access in
 * slice 01. Chunk coordinates are folded where the renderer looks them up; the
 * generator itself treats every coordinate as its own chunk, so `chunkAt(seed,
 * -1, 5)` and `chunkAt(seed, 6, 5)` are two different chunks with two different
 * streams that happen to describe the same block.
 *
 * COORDINATES
 * -----------
 * Two frames, and mixing them up is the bug this header exists to prevent:
 *
 *   - FOLDED (canonical): integer coordinates in [0, GRID). The world repeats
 *     every WORLD_EXTENT metres, so anything past +/-WORLD_HALF is the same
 *     place as its negative. Folded, the seven road axes sit at -192..+192 m
 *     and the seven block centres at -224..+160 m.
 *   - UNFOLDED (plane): integer coordinates with no fold. The block at cx = 6
 *     spans avenue 6 to avenue 7, and avenue 7 is 256 m out — past the +192
 *     road, because avenue 0 also lives there. Its centre is +224, exactly one
 *     period beyond the fold of its own position.
 *
 * So `blockCentre` is deliberately UNFOLDED and can return a value outside
 * +/-WORLD_HALF. That is correct, not a leak: the view layer draws the folded
 * copy as well (slice 09). Only `chunkAtWorld` deals in folded coordinates.
 *
 * PURE: no DOM, no Three.js, no globals, no clock. `verify.mjs` imports this
 * file directly in node.
 */

import { streamAt } from './hash.js'

// ---------------------------------------------------------------------------
// constants (GAMEDESIGN.md §3.1)
// ---------------------------------------------------------------------------

/** Blocks per axis. One block is one chunk. */
export const GRID = 7

/** Metres per block edge. */
export const BLOCK = 64

/** Full extent of the wrapped world, metres. */
export const WORLD_EXTENT = GRID * BLOCK

/**
 * Districts are the 2 x 2 quadrants of the block grid. GRID is odd, so the split
 * is 4/3 blocks per axis and the four districts hold 16, 12, 12 and 9 blocks.
 * Uneven, but deterministic — and §3.4's nearest-N anchor pool absorbs the size
 * difference, so the districts stay comparable when objectives are placed in 03.
 */
export const DISTRICT_AXES = 2
export const DISTRICTS = DISTRICT_AXES * DISTRICT_AXES

/** North-south roads, indexed 0..GRID-1. */
export const AVENUES = GRID

/** East-west roads, indexed 0..GRID-1. */
export const STREETS = GRID

/** Where avenues cross streets. */
export const INTERSECTIONS = AVENUES * STREETS

/** Block sides, in the order used by every corner/lot array in this file. */
export const SIDE_NAMES = Object.freeze(['N', 'E', 'S', 'W'])

/** Metres from the street centreline to a lot's front face. */
export const SETBACK = 9

/** How far a lot extends back from its front face. */
export const LOT_DEPTH = 20

/** What a lot is built as. Drawn from the chunk's own stream. */
export const LOT_KINDS = Object.freeze(['house', 'garage', 'shed'])

// ---------------------------------------------------------------------------
// wrap + coordinates (§3.3)
// ---------------------------------------------------------------------------

/**
 * wrap — fold any integer into [0, n). The one function the whole toroidal
 * world rests on, so it handles negatives properly: plain `%` returns -1 for
 * -1, and a negative chunk index is exactly what streaming will hand us.
 *
 * @param {number} v
 * @param {number} n
 * @returns {number} the folded value
 */
export function wrap(v, n) {
  return ((v % n) + n) % n
}

/**
 * resolveChunk — fold chunk coordinates into canonical range.
 *
 * This is the line that deferred streaming deletes. Everything else in v2 asks
 * for chunks by folded coordinate and is unaffected.
 *
 * @param {number} cx
 * @param {number} cz
 * @returns {{ cx: number, cz: number }} canonical chunk coordinate
 */
export function resolveChunk(cx, cz) {
  return { cx: wrap(cx, GRID), cz: wrap(cz, GRID) }
}

/** Canonical key for a chunk coordinate. */
export function chunkKey(cx, cz) {
  const key = resolveChunk(cx, cz)
  return key.cx * GRID + key.cz
}

/** Which of the four districts a chunk coordinate falls in (0..3). */
export function districtOf(cx, cz) {
  const half = Math.ceil(GRID / DISTRICT_AXES)
  const key = resolveChunk(cx, cz)
  return (key.cx < half ? 0 : 1) * DISTRICT_AXES + (key.cz < half ? 0 : 1)
}

/** Half the world extent, metres. */
export const WORLD_HALF = WORLD_EXTENT / 2

/** Folded world coordinate of road axis `index` (avenue x, or street z). */
export function roadAxisToWorld(index) {
  return (wrap(index, GRID) - (GRID - 1) / 2) * BLOCK
}

/**
 * UNFOLDED centre of block (cx, cz). Can fall outside ±WORLD_HALF — see the
 * COORDINATES note in the file header.
 */
export function blockCentre(cx, cz) {
  const key = resolveChunk(cx, cz)
  return {
    x: (key.cx - (GRID - 1) / 2 + 0.5) * BLOCK,
    z: (key.cz - (GRID - 1) / 2 + 0.5) * BLOCK,
  }
}

/** The folded chunk containing a world position. Inverse of `blockCentre`. */
export function chunkAtWorld(x, z) {
  // block cx spans [(cx - (GRID-1)/2) * BLOCK, +BLOCK), so the index is
  // floor(x / BLOCK) + (GRID-1)/2. Using GRID/2 here instead would shift every
  // lookup by half a block.
  return {
    cx: wrap(Math.floor(x / BLOCK) + (GRID - 1) / 2, GRID),
    cz: wrap(Math.floor(z / BLOCK) + (GRID - 1) / 2, GRID),
  }
}

/** World position of a street intersection. */
export function intersectionToWorld(ax, az) {
  return { x: roadAxisToWorld(ax), z: roadAxisToWorld(az) }
}

// ---------------------------------------------------------------------------
// the street graph (static, seed-independent — geometry is fixed per run)
// ---------------------------------------------------------------------------

/** Canonical node id for an intersection. */
export function streetNodeId(ax, az) {
  return wrap(ax, GRID) * GRID + wrap(az, GRID)
}

/** Intersection coordinates for a node id. */
export function streetNodeCoords(id) {
  return { ax: Math.floor(id / GRID), az: wrap(id, GRID) }
}

/** World position of a node id. */
export function streetNodeToWorld(id) {
  return intersectionToWorld(streetNodeCoords(id).ax, streetNodeCoords(id).az)
}

/**
 * Adjacency of the wrapped street grid, built once and frozen. Every node has
 * four neighbours; the edges between `GRID-1` and `0` are the seam, and they are
 * the reason the world reads as endless.
 */
export const STREET_ADJ = (() => {
  const adj = []
  for (let id = 0; id < INTERSECTIONS; id++) adj.push([])
  for (let ax = 0; ax < AVENUES; ax++) {
    for (let az = 0; az < STREETS; az++) {
      const id = streetNodeId(ax, az)
      adj[id].push(streetNodeId(ax + 1, az)) // east
      adj[id].push(streetNodeId(ax - 1, az)) // west, crosses the seam at ax = 0
      adj[id].push(streetNodeId(ax, az + 1)) // south
      adj[id].push(streetNodeId(ax, az - 1)) // north, crosses the seam at az = 0
    }
  }
  return Object.freeze(adj.map((neighbours) => Object.freeze(neighbours)))
})()

/** Undirected edge count of the street graph. 49 nodes x 4 / 2 = 98. */
export function streetEdgeCount() {
  let count = 0
  for (const neighbours of STREET_ADJ) count += neighbours.length
  return count / 2
}

/** The four intersections bounding a block, in SIDE_NAMES order. */
export function blockCorners(cx, cz) {
  const key = resolveChunk(cx, cz)
  return Object.freeze([
    streetNodeId(key.cx, key.cz), // N-west
    streetNodeId(key.cx + 1, key.cz), // N-east
    streetNodeId(key.cx + 1, key.cz + 1), // S-east
    streetNodeId(key.cx, key.cz + 1), // S-west
  ])
}


// ---------------------------------------------------------------------------
// graph queries — the BFS helpers slice 03 places objectives with
// ---------------------------------------------------------------------------

/** Normalise anything intersection-shaped (a node id, or a raw ax/az pair key). */
function normaliseNode(value) {
  if (typeof value === 'object' && value !== null) return streetNodeId(value.ax, value.az)
  const { ax, az } = streetNodeCoords(value)
  return streetNodeId(ax, az)
}

/** BFS step count from `from` to every intersection; -1 where unreachable. */
export function streetDistanceMap(from = 0) {
  const dist = new Int32Array(INTERSECTIONS).fill(-1)
  const start = normaliseNode(from)
  dist[start] = 0
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    for (const next of STREET_ADJ[cur]) {
      if (dist[next] !== -1) continue
      dist[next] = dist[cur] + 1
      queue.push(next)
    }
  }
  return dist
}

/** Every intersection reachable from `from`, as a Set of node ids. */
export function reachableIntersections(from = 0) {
  const dist = streetDistanceMap(from)
  const seen = new Set()
  for (let id = 0; id < INTERSECTIONS; id++) {
    if (dist[id] >= 0) seen.add(id)
  }
  return seen
}

export function hasStreetPath(from, to) {
  return streetPathLength(from, to) >= 0
}

/** Shortest route in intersections between two nodes (BFS); -1 if unreachable. */
export function streetPathLength(from, to) {
  const start = normaliseNode(from)
  const target = normaliseNode(to)
  if (start === target) return 0
  const dist = new Int32Array(INTERSECTIONS).fill(-1)
  dist[start] = 0
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    for (const next of STREET_ADJ[cur]) {
      if (dist[next] !== -1) continue
      dist[next] = dist[cur] + 1
      if (next === target) return dist[next]
      queue.push(next)
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// chunk generation (§3.2 — random access, no shared state between chunks)
// ---------------------------------------------------------------------------

/** Distinct chunks in the wrapped world. */
export const CHUNKS = GRID * GRID

/**
 * buildLots — one lot per block side, inset from the street by `SETBACK`.
 *
 * Every block fronts streets on all four sides, which is what makes the
 * "no fixture on a street cell" rule in §3.6 easy to state: a lot is always
 * strictly inside its block. `kind` and `tint` are the chunk's own variation and
 * are the first thing slice 04's fixture pass has to respect.
 */
function buildLots(rng, centre) {
  const half = BLOCK / 2
  const along = BLOCK - 2 * SETBACK // extent parallel to the street
  const deep = LOT_DEPTH / 2
  const lots = []
  for (const side of SIDE_NAMES) {
    let x = centre.x
    let z = centre.z
    if (side === 'N') z = centre.z - half + SETBACK + deep
    else if (side === 'E') x = centre.x + half - SETBACK - deep
    else if (side === 'S') z = centre.z + half - SETBACK - deep
    else x = centre.x - half + SETBACK + deep // 'W'
    const wide = side === 'N' || side === 'S'
    lots.push({
      id: side,
      side,
      x,
      z,
      w: wide ? along : deep * 2,
      d: wide ? deep * 2 : along,
      kind: LOT_KINDS[Math.floor(rng() * LOT_KINDS.length)],
      tint: Math.floor(rng() * 4),
    })
  }
  return lots
}

/**
 * chunkAt — generate one chunk. Pure and random-access: the result depends on
 * nothing but `(seed, cx, cz)`, and no other chunk.
 *
 * `cx`/`cz` are used UNFOLDED to draw the chunk's randomness, so two
 * coordinates that name the same block still get different streams. That is
 * the streaming contract: when the world stops wrapping, `-1` becomes a real
 * chunk next door to `0` instead of a duplicate of it.
 *
 * @param {number} seed the run's base seed
 * @param {number} cx chunk x, unfolded
 * @param {number} cz chunk z, unfolded
 * @returns {object} chunk (JSON-serialisable, no functions)
 */
export function chunkAt(seed, cx, cz) {
  const chunk = {
    cx,
    cz,
    key: chunkKey(cx, cz),
    district: districtOf(cx, cz),
    block: BLOCK,
    centre: blockCentre(cx, cz),
    corners: blockCorners(cx, cz),
    lots: buildLots(streamAt(seed, cx, cz), blockCentre(cx, cz)),
    props: [], // slice 04 fills this; empty here so the shape is already right
  }
  return { ...chunk, signature: chunkSignature(chunk) }
}

/**
 * chunkSignature — stable fingerprint of a chunk's CONTENT.
 *
 * Deliberately excludes the unfolded `cx`/`cz`, so two coordinates that fold to
 * the same block differ here only if their lots genuinely differ. That is what
 * makes the out-of-range test in slice 02 meaningful instead of tautological.
 */
export function chunkSignature(chunk) {
  const lots = chunk.lots.map((lot) => `${lot.side}:${lot.kind}:${lot.tint}`).join(',')
  return `${chunk.key}#${chunk.district}#${chunk.corners.join('.')}#${chunk.centre.x},${chunk.centre.z}#${lots}`
}

export default chunkAt

