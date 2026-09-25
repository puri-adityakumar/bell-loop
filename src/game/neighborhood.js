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

// ---------------------------------------------------------------------------
// objective anchors (§3.4 — the shrine fairness rule, welded to districts)
// ---------------------------------------------------------------------------

/**
 * SPAWN — where a run starts. Fixed forever, like v1's `ENTRANCE`: the distances
 * below are only meaningful because the origin never moves.
 */
export const SPAWN = Object.freeze({
  cx: 0,
  cz: 0,
  node: streetNodeId(0, 0),
  // on the pavement inside block (0,0), a few metres off the corner intersection
  position: Object.freeze({ x: roadAxisToWorld(0) + 4, z: roadAxisToWorld(0) + 4 }),
})

/**
 * Floor on graph distance from spawn, in street steps. The whole map is only 6
 * steps across (§3.1), so 3 is "at least halfway" — a real walk — and it keeps
 * 25 of the 49 blocks in play. Blocks closer than this never host an objective.
 */
export const MIN_OBJECTIVE_DISTANCE = 3

/**
 * Ceiling pool: objectives are drawn from the nearest N eligible blocks in their
 * district, so nothing becomes a trek across the whole neighbourhood. A district
 * with fewer eligible blocks than the pool simply uses all of them — the far
 * quadrant has only 3, so the hammer's block is always one of those three.
 */
export const OBJECTIVE_POOL = 6

/**
 * Minimum separation between the hammer's block and every portal's block, in
 * BLOCK CENTRES. 2 means one whole block between them, 128 m.
 *
 * This is NOT `MIN_OBJECTIVE_DISTANCE`, and the difference is measured, not
 * stylistic. The far quadrant (district 3) is graph-adjacent to districts 1 and
 * 2, and on a map whose entire diameter is 6 street steps the maximum walking
 * separation between them is 2 — so a rule demanding `MIN_OBJECTIVE_DISTANCE` (3)
 * street steps leaves ZERO candidates for portals B and C, under every possible
 * district-to-objective mapping. It is simply not satisfiable on this map.
 *
 * What 2 block centres buys is the guarantee the design actually wants: no two
 * objectives ever sit on adjacent blocks, so no errand can be completed on the
 * way to another. Verified worst case leaves portal pools of 9, 3 and 3
 * candidates, so the world still varies from seed to seed.
 */
export const MIN_ANCHOR_SEPARATION = 2

/** Objective identity is welded to a district, exactly as v1 welded shrines to zones. */
export const PORTAL_IDS = Object.freeze(['A', 'B', 'C'])
export const HAMMER_ID = 'HAMMER'
export const EXIT_ID = 'EXIT'
export const ANCHOR_IDS = Object.freeze([...PORTAL_IDS, HAMMER_ID, EXIT_ID])

/** Which district each objective belongs to. The exit is deliberately absent. */
export const OBJECTIVE_DISTRICT = Object.freeze({ A: 0, B: 1, C: 2, [HAMMER_ID]: 3 })

/** Salt for the anchor stream, so picking a lot cannot disturb lot CONTENT (§3.6). */
const ANCHOR_SALT = 0x5eed1234

/** Minimum walking distance, in street steps, from spawn to a block. */
export function blockDistanceFromSpawn(cx, cz) {
  const dist = streetDistanceMap(SPAWN.node)
  return Math.min(...blockCorners(cx, cz).map((corner) => dist[corner]))
}

/** Minimum walking distance, in street steps, between two blocks. */
export function blockDistance(a, b) {
  let best = Infinity
  for (const from of blockCorners(a.cx, a.cz)) {
    for (const to of blockCorners(b.cx, b.cz)) {
      const length = streetPathLength(from, to)
      if (length >= 0 && length < best) best = length
    }
  }
  return best === Infinity ? -1 : best
}

/**
 * blockCentreDistance — separation between two blocks measured centre to
 * centre, in BLOCKS, folded across the wrap.
 *
 * This is the metric the hammer/portal separation rule uses, and it is
 * deliberately not `blockDistance`. Walking distance is min-over-corners, so two
 * blocks either side of one street are 1 step apart and 1 step apart for blocks
 * half the map away — it cannot express "far enough to be its own errand". Centre
 * distance does, and it is stable under the wrap.
 *
 * @returns {number} distance in blocks; 1 means adjacent, 2 means one block
 * between, and so on
 */
export function blockCentreDistance(a, b) {
  const dx = Math.min(Math.abs(a.cx - b.cx), GRID - Math.abs(a.cx - b.cx))
  const dz = Math.min(Math.abs(a.cz - b.cz), GRID - Math.abs(a.cz - b.cz))
  return Math.sqrt(dx * dx + dz * dz)
}

/**
 * objectiveCandidates — eligible blocks per district, nearest first.
 *
 * Eligibility is purely structural (distance from spawn); the seeded pick happens
 * in `placeObjectives`. Keeping the two apart is what lets slice 03 assert the
 * fairness rule without also depending on how the PRNG happened to land.
 */
export function objectiveCandidates() {
  const pools = []
  for (let district = 0; district < DISTRICTS; district++) pools.push([])
  for (let cx = 0; cx < GRID; cx++) {
    for (let cz = 0; cz < GRID; cz++) {
      const distance = blockDistanceFromSpawn(cx, cz)
      if (distance < MIN_OBJECTIVE_DISTANCE) continue
      pools[districtOf(cx, cz)].push({ cx, cz, key: chunkKey(cx, cz), distance })
    }
  }
  // nearest first, key as the tiebreak so the order is total and deterministic
  for (const pool of pools) pool.sort((a, b) => a.distance - b.distance || a.key - b.key)
  return pools
}


/** The lot an anchor sits on, chosen from a stream salted away from lot content. */
function pickAnchorLot(seed, chunk) {
  const rng = streamAt((seed ^ ANCHOR_SALT) >>> 0, chunk.cx, chunk.cz)
  return chunk.lots[Math.floor(rng() * chunk.lots.length)]
}

function makeAnchor(seed, id, kind, cx, cz, distance, extra = {}) {
  const chunk = chunkAt(seed, cx, cz)
  const lot = pickAnchorLot(seed, chunk)
  const anchor = {
    id,
    kind,
    district: kind === 'exit' ? null : districtOf(cx, cz),
    chunk: { cx, cz },
    key: chunk.key,
    lot: { id: lot.id, side: lot.side, x: lot.x, z: lot.z, w: lot.w, d: lot.d },
    position: { x: lot.x, z: lot.z },
    distance,
    ...extra,
  }
  return { ...anchor, signature: anchorSignature(anchor) }
}

/** Stable fingerprint of one anchor's placement. */
export function anchorSignature(anchor) {
  return `${anchor.id}:${anchor.kind}:${anchor.chunk.cx},${anchor.chunk.cz}:${anchor.lot.side}:${anchor.position.x},${anchor.position.z}`
}

/** Stable fingerprint of a whole objective set. */
export function objectivesSignature(objectives) {
  return objectives.all.map((anchor) => anchor.signature).join('|')
}

/** Placement must never silently degrade; a starved pool is a design bug. */
function assertPool(id, pool) {
  if (pool.length === 0) {
    throw new Error(
      `objective pool for ${id} is empty: MIN_OBJECTIVE_DISTANCE=${MIN_OBJECTIVE_DISTANCE} and OBJECTIVE_POOL=${OBJECTIVE_POOL} leave no candidate`,
    )
  }
}

/**
 * placeObjectives — the three portals, the hammer and the exit for one run.
 *
 * ORDER MATTERS, and deliberately so. The hammer is placed first because it is
 * the most constrained objective — it lives in the far quadrant, which has only
 * three blocks clearing MIN_OBJECTIVE_DISTANCE — and every portal is then drawn
 * from a pool with blocks too close to the hammer filtered out. That makes
 * "the hammer is its own errand" (§7.1) true *by construction* rather than by
 * luck of the seed. See MIN_ANCHOR_SEPARATION for why the separation is measured
 * in block centres rather than in the street steps of MIN_OBJECTIVE_DISTANCE.
 *
 * The exit is placed last and is not district-allocated: it is the block of
 * maximum distance from spawn. For GRID = 7 that block is unique — the
 * antipodal one — so the exit is a fixed point of the run for the same reason the
 * hammer is, and the headlights beacon in §10.3 is a place you can learn rather
 * than re-roll every run. Ties are still broken by the seed, so the rule stays
 * correct if GRID ever changes.
 *
 * `loopNumber` is accepted and deliberately ignored. Callers have one in hand and
 * should not have to think about it; the fact that passing 1..8 changes nothing is
 * asserted in verify.mjs, because it is the property that makes dying unable to
 * erase the goal (§7.1).
 *
 * @param {number} seed the run's base seed
 * @param {number} [loopNumber] accepted and ignored — see above
 * @returns {object} the objective set
 */
export function placeObjectives(seed, loopNumber = 1) {
  void loopNumber
  const pools = objectiveCandidates()
  const hammerPool = pools[OBJECTIVE_DISTRICT[HAMMER_ID]]
  assertPool(HAMMER_ID, hammerPool)
  const hammerRng = streamAt(seed, 0x48414d4d, 0x4552) // "HAMMER"
  const hammerBlock = hammerPool[Math.floor(hammerRng() * hammerPool.length)]

  const anchors = []
  for (const id of PORTAL_IDS) {
    const district = OBJECTIVE_DISTRICT[id]
    // drop blocks too close to the hammer, so the separation rule holds
    const pool = pools[district]
      .filter((block) => blockCentreDistance(block, hammerBlock) >= MIN_ANCHOR_SEPARATION)
      .slice(0, OBJECTIVE_POOL)
    assertPool(id, pool)
    const rng = streamAt(seed, 0x504f5254 + id.charCodeAt(0), district) // "PORT"
    const block = pool[Math.floor(rng() * pool.length)]
    anchors.push(
      makeAnchor(seed, id, 'portal', block.cx, block.cz, block.distance, {
        separation: blockCentreDistance(block, hammerBlock),
      }),
    )
  }
  anchors.push(
    makeAnchor(seed, HAMMER_ID, 'hammer', hammerBlock.cx, hammerBlock.cz, hammerBlock.distance, {
      separation: null,
    }),
  )

  const exitBlock = pools.flat().reduce((best, block) => (block.distance > best.distance ? block : best))
  anchors.push(makeAnchor(seed, EXIT_ID, 'exit', exitBlock.cx, exitBlock.cz, exitBlock.distance))

  const byId = Object.fromEntries(anchors.map((anchor) => [anchor.id, anchor]))
  const result = {
    seed,
    spawn: SPAWN,
    portals: PORTAL_IDS.map((id) => byId[id]),
    hammer: byId[HAMMER_ID],
    exit: byId[EXIT_ID],
    all: ANCHOR_IDS.map((id) => byId[id]),
  }
  return { ...result, signature: objectivesSignature(result) }
}


