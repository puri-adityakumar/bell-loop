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
export const LOT_DEPTH = 10

/**
 * How wide a lot runs along its street.
 *
 * This is not a taste decision, it is a hard geometric limit. The four lots of a
 * block meet at the corners, and two adjacent lots overlap unless
 *
 *     LOT_WIDTH <= BLOCK - 2 * SETBACK - 2 * LOT_DEPTH
 *
 * With the previous LOT_WIDTH of 46 (the whole block minus two setbacks) and a
 * depth of 20, every adjacent pair of lots overlapped by 400 m², and fixtures
 * placed on neighbouring lots could land inside one another — four of 346 did.
 * Sizing the width to exactly that bound is the widest lot that tiles the block
 * without sharing ground, and the value is derived rather than typed so the
 * constraint cannot drift when BLOCK or SETBACK change.
 */
export const LOT_WIDTH = BLOCK - 2 * SETBACK - 2 * LOT_DEPTH

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

/**
 * THE CANONICAL WINDOW, AND WHY IT IS NOT [-224, +224]
 * ---------------------------------------------------
 * Everything in this file speaks CANONICAL metres: the seven road axes sit at
 * -192..+192 and every anchor, fixture and block centre is a canonical number.
 * The *drawn* copy of the map is that canonical map translated by a whole-period
 * offset, and the copy the player is standing in is chosen so that the player's
 * canonical coordinate lands in
 *
 *     [CANONICAL_ORIGIN, CANONICAL_ORIGIN + WORLD_EXTENT)  =  [-192, +256)
 *
 * which is a half-period window, not a symmetric one. The asymmetry is forced by
 * the grid: seven axes at 64 m spacing span 384 m, so the eighth axis — the one the
 * wrap closes on — is at +256, and a window of [-224, +224) would cut it in half.
 *
 * This matters because canonical coordinates and *world* coordinates (the ones the
 * player's body carries, which never wrap) are a half-period apart, and every
 * distance between the two has to be folded *in one frame* or it is silently wrong
 * by three blocks. `canonicalCoord` is that fold, and it is the only definition of
 * it in the codebase.
 */
export const CANONICAL_ORIGIN = (wrap(0, GRID) - (GRID - 1) / 2) * BLOCK

/**
 * originFor — the period offset of the wrapped copy that contains world position
 * `x`: the number a caller adds to a canonical coordinate to draw it where the
 * player is.
 *
 * The `CANONICAL_ORIGIN` in the numerator is the whole function. The obvious
 * `round(x / WORLD_EXTENT) * WORLD_EXTENT` is 192 m out, because the window is
 * anchored at -192 rather than at 0, and a floor instead of a round puts the seam
 * 64 m the wrong way round in exactly one direction — the seam would then be
 * visible in one direction only, which is the bug this function exists to prevent.
 */
export function originFor(x) {
  const periods = Math.floor((x - 2 * CANONICAL_ORIGIN) / WORLD_EXTENT)
  return CANONICAL_ORIGIN + periods * WORLD_EXTENT
}

/**
 * canonicalCoord — a world coordinate in the canonical frame.
 *
 * `x - originFor(x)` is the local coordinate of whichever copy is drawn around `x`,
 * and it is a pure function of `x`, so a caller holding only a world position can
 * put it in the same frame as the node table without asking the view layer where it
 * put the world. That is what `creature.js` needs, and what it did without: the
 * balance simulation in `verify-world.mjs` found `nearestIntersection` answering
 * three blocks away from the truth for 8,395 of 8,208 sampled world positions,
 * because it differenced world coordinates against canonical ones and let
 * `wrapDelta` fold the frame offset away along with the wrap.
 */
export function canonicalCoord(x) {
  return x - originFor(x)
}

/**
 * worldPointOf — a canonical point in the frame the player is in, which is the
 * frame every *live* caller of `creature.js` holds a position in.
 *
 * It is `p + CANONICAL_ORIGIN`, because a canonical point is *drawn* at
 * `p + origin` and the origins are `CANONICAL_ORIGIN` plus whole periods; and it
 * inverts `canonicalCoord` for every point inside the canonical window, which is
 * what makes the seam testable from either side. (The sign is the whole function:
 * the obvious `p - CANONICAL_ORIGIN` produces a coordinate one block north of the
 * point it claims to be, which reads as a plausible number.)
 *
 * It exists because the two frames have to be nameable from both sides:
 * `creature.js` reads world positions (`nodeId`, `nearestIntersection`,
 * `streetRoute`, `reemergeNode`'s player) and answers in canonical ones
 * (`reemergeNode`'s placement, `streetNodeToWorld`), and a caller that starts from
 * an anchor, a spawn or a node has to cross over without re-deriving the offset.
 * One definition, in the module that owns the wrap.
 *
 * @param {{x:number,z:number}} canonical
 * @returns {{x:number,z:number}} the same torus point, in world coordinates
 */
export function worldPointOf(canonical) {
  return { x: canonical.x + CANONICAL_ORIGIN, z: canonical.z + CANONICAL_ORIGIN }
}

/**
 * nearestImage — the image of a canonical point that a world point is closest to.
 *
 * `originFor` picks the copy of the MAP that the player is standing in, and
 * `worldOf` adds that offset to whatever it is handed. That is the right answer for
 * everything the world *places* — an anchor, a lot centre, a node — because those
 * are canonical numbers in the canonical window and the offset lands them in the
 * copy the player can see. It is the wrong answer for a thing that WALKS, and the
 * balance simulation in `verify-world.mjs` is what found the difference: an ENRAGED
 * creature in the finale of seed 8 spent 508 s inside `BANISH_RANGE` of the player
 * and was never once banished and never once captured, and the reason was that its
 * stored canonical coordinate had walked a whole period out of the map it was being
 * drawn in. Every number the world derives from the pair — `CAPTURE_RADIUS`,
 * `BANISH_RANGE`, the awareness meter's distance, §6.4's proximity breath — was
 * reading a whole 448 m period of nothing, while the harness's own folded measure
 * read 0.0 m. The figure stood inside the player and the game could not see it.
 *
 * The fold is `nearestImage`, and it is the same fold the harness routes with
 * (`nearestCopy` in `verify-world.mjs` used to be its own copy of these two lines).
 * `round` rather than `floor` so the two images of a point exactly half a period
 * apart are chosen consistently, and the answer is idempotent: folding an already
 * folded point is itself, so a caller can apply it every frame without the position
 * drifting.
 *
 * The answer is a CANONICAL coordinate and may sit a whole period outside the
 * canonical window. That is deliberate and harmless: `nodeId` and
 * `nearestIntersection` fold, so every graph query is unaffected, and
 * `streetView.worldOf` composes with this fold into the image nearest the player,
 * which is the whole point — the picture and the AI have to be the same creature.
 *
 * @param {{x:number,z:number}} canonical
 * @param {{x:number,z:number}} nearWorld a world position — the player's
 * @returns {{x:number,z:number}} canonical, in the image nearest `nearWorld`
 */
export function nearestImage(canonical, nearWorld) {
  const nearX = canonicalCoord(nearWorld.x)
  const nearZ = canonicalCoord(nearWorld.z)
  return {
    x: canonical.x + WORLD_EXTENT * Math.round((nearX - canonical.x) / WORLD_EXTENT),
    z: canonical.z + WORLD_EXTENT * Math.round((nearZ - canonical.z) / WORLD_EXTENT),
  }
}

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
  const along = LOT_WIDTH
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


// ---------------------------------------------------------------------------
// the per-loop fixture pass (§3.6)
// ---------------------------------------------------------------------------

/**
 * Fixture kinds, split by the one thing that differs between them: whether the
 * player can walk through them. A structural fixture rebuilds the collider set
 * at reset; a decorative one costs nothing, which is why the two churn freely
 * while only the structural half has to respect the clearance rules.
 */
export const STRUCTURAL_KINDS = Object.freeze([
  Object.freeze({ kind: 'hedge', w: 8.0, d: 1.2 }),
  Object.freeze({ kind: 'car', w: 4.6, d: 2.0 }),
  Object.freeze({ kind: 'bin', w: 0.8, d: 0.8 }),
  Object.freeze({ kind: 'fence', w: 6.0, d: 0.3 }),
  Object.freeze({ kind: 'shed', w: 3.0, d: 2.5 }),
])

export const DECORATIVE_KINDS = Object.freeze([
  Object.freeze({ kind: 'window', w: 1.2, d: 0.2 }),
  Object.freeze({ kind: 'porchLight', w: 0.4, d: 0.4 }),
  Object.freeze({ kind: 'stake', w: 0.3, d: 0.3 }),
  Object.freeze({ kind: 'cone', w: 0.4, d: 0.4 }),
])

/** Half the road width. Rule 1: no fixture may come within this of a centreline. */
export const STREET_HALF_WIDTH = 6

/** Width of the walkable approach from the street to a lot's anchor point. */
export const APPROACH_WIDTH = 3

/** Chance a given slot receives a fixture at all. */
export const FIXTURE_DENSITY = 0.75

/** Blocks within this Chebyshev radius of spawn are kept clear of fixtures. */
export const SPAWN_CLEARANCE_BLOCKS = 1

/**
 * loopSalt — decorrelate adjacent loops.
 *
 * Fixtures are keyed `hash32(seed ^ loopSalt(loop), cx, cz)`, so if adjacent
 * loops produced similar salts the world would barely change between them, and
 * "the fixture pass actually does something" would be a lie. Multiplying by a
 * large odd constant before the final xor means loop N and loop N+1 land in
 * unrelated salts, which slice 04's checks verify directly.
 */
export function loopSalt(loopNumber) {
  return (Math.imul(loopNumber + 1, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0
}

/**
 * lotSlots — the three positions on a lot a fixture may occupy, spread along
 * the lot's long axis at its centre depth. The middle one is the approach slot:
 * it sits on the line from the street to the anchor, which is what makes rule 3
 * a real constraint rather than a formality.
 */
export function lotSlots(lot) {
  const alongX = lot.w >= lot.d
  // thirds, not quarters: the widest fixture is an 8 m hedge, and two of them on
  // the same lot must not touch, so slot spacing has to exceed 8 m. LOT_WIDTH / 3
  // is 8.67 m, which clears it; LOT_WIDTH / 4 would be 6.5 m and would collide.
  const offset = Math.max(lot.w, lot.d) / 3
  if (alongX) {
    return [
      { slot: 0, x: lot.x - offset, z: lot.z },
      { slot: 1, x: lot.x, z: lot.z },
      { slot: 2, x: lot.x + offset, z: lot.z },
    ]
  }
  return [
    { slot: 0, x: lot.x, z: lot.z - offset },
    { slot: 1, x: lot.x, z: lot.z },
    { slot: 2, x: lot.x, z: lot.z + offset },
  ]
}

/** The middle slot — the one on the approach to the lot's anchor. */
export const APPROACH_SLOT = 1

/**
 * lotApproach — the corridor from the street to a lot's anchor point, as an
 * axis-aligned rectangle. Rule 3 is stated against this shape, and asserted by
 * footprint overlap rather than by slot index, so growing a fixture or adding a
 * slot in the corridor is caught even though the slot index check would not.
 */
export function lotApproach(lot) {
  const half = APPROACH_WIDTH / 2
  if (lot.w >= lot.d) {
    // long axis is x, so the approach runs along z from the front face inwards
    const front = lot.side === 'N' ? lot.z - lot.d / 2 : lot.z
    const back = lot.side === 'N' ? lot.z : lot.z + lot.d / 2
    return { x0: lot.x - half, x1: lot.x + half, z0: front, z1: back }
  }
  const front = lot.side === 'W' ? lot.x - lot.w / 2 : lot.x
  const back = lot.side === 'W' ? lot.x : lot.x + lot.w / 2
  return { x0: front, x1: back, z0: lot.z - half, z1: lot.z + half }
}

/** True when two axis-aligned rectangles overlap (touching does not count). */
export function rectsOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1
}


/**
 * Chebyshev ring distance between two chunks, folded across the wrap — the
 * number of blocks you must cross in the worst axis to get from one to the
 * other. Max of the two per-axis folded distances, NOT min: taking the min
 * would make almost every block "adjacent" and silently clear a third of the map.
 */
function blockRingDistance(cx, cz, ox, oz) {
  const dx = Math.abs(wrap(cx - ox, GRID))
  const dz = Math.abs(wrap(cz - oz, GRID))
  return Math.max(Math.min(dx, GRID - dx), Math.min(dz, GRID - dz))
}

/** Rule 2: the spawn clearance zone, where the player must never be obstructed. */
export function inSpawnClearance(cx, cz) {
  return blockRingDistance(cx, cz, SPAWN.cx, SPAWN.cz) <= SPAWN_CLEARANCE_BLOCKS
}

/**
 * reservedLots — the lots that must stay clear, as `cx,cz,side` keys.
 *
 * Rule 2 and rule 4 together: every objective anchor sits on one of these lots,
 * and so does every lot in the spawn clearance zone. Keyed by side rather than by
 * coordinates so that the *lot* is protected, not merely the single point an
 * anchor happens to occupy — a car beside the portal is as good as a car on it.
 */
export function reservedLots(objectives) {
  const reserved = new Set()
  for (const anchor of objectives.all) {
    reserved.add(`${anchor.chunk.cx},${anchor.chunk.cz},${anchor.lot.side}`)
  }
  for (let cx = 0; cx < GRID; cx++) {
    for (let cz = 0; cz < GRID; cz++) {
      if (!inSpawnClearance(cx, cz)) continue
      for (const side of SIDE_NAMES) reserved.add(`${cx},${cz},${side}`)
    }
  }
  return reserved
}

/**
 * chunkFixtures — the fixture pass for one chunk on one loop.
 *
 * Pure and random-access, keyed `hash32(seed ^ loopSalt(loop), cx, cz)`: nothing
 * outside this chunk is read, so slice 09 can build the blocks near the player
 * without generating the whole neighbourhood first.
 *
 * @param {number} seed
 * @param {number} loopNumber 1-based; changing it changes the whole world dressing
 * @param {number} cx
 * @param {number} cz
 * @param {Set<string>} reserved from `reservedLots`
 * @returns {object[]} fixtures, in a stable order
 */
export function chunkFixtures(seed, loopNumber, cx, cz, reserved) {
  const chunk = chunkAt(seed, cx, cz)
  const rng = streamAt((seed ^ loopSalt(loopNumber)) >>> 0, cx, cz)
  const fixtures = []
  for (const lot of chunk.lots) {
    const isReserved = reserved.has(`${cx},${cz},${lot.side}`)
    // fixtures lie along their lot's long axis, so a hedge runs parallel to the
    // street it was placed against rather than sticking out into the block
    const alongX = lot.w >= lot.d
    for (const anchor of lotSlots(lot)) {
      // rule 2: a reserved lot keeps its whole footprint free of fixtures
      if (isReserved) continue
      if (rng() >= FIXTURE_DENSITY) continue
      // the two classes are drawn independently, so a loop can be mostly
      // decorative and the next one mostly solid
      const structural = rng() < 0.5
      const table = structural ? STRUCTURAL_KINDS : DECORATIVE_KINDS
      const spec = table[Math.floor(rng() * table.length)]
      const w = alongX ? spec.w : spec.d
      const d = alongX ? spec.d : spec.w
      fixtures.push({
        id: `${cx},${cz},${lot.side},${anchor.slot}`,
        cls: structural ? 'structural' : 'decorative',
        kind: spec.kind,
        collides: structural,
        chunk: { cx, cz },
        lot: lot.side,
        slot: anchor.slot,
        x: anchor.x,
        z: anchor.z,
        w,
        d,
        loop: loopNumber,
      })
    }
  }
  return fixtures
}

/**
 * fixturePass — the whole neighbourhood's dressing for one loop.
 *
 * A discrete event at reset, not a per-frame cost, which is why v1's existing
 * reset path absorbs it without modification (§3.6). The geometry it dresses is
 * NOT loop-dependent: streets, lots and objective anchors are fixed for the run,
 * so this is the only part of the world that churns.
 *
 * @param {number} seed
 * @param {number} [loopNumber] 1-based
 * @returns {object} the pass
 */
export function fixturePass(seed, loopNumber = 1) {
  const objectives = placeObjectives(seed, loopNumber)
  const reserved = reservedLots(objectives)
  const fixtures = []
  for (let cx = 0; cx < GRID; cx++) {
    for (let cz = 0; cz < GRID; cz++) {
      fixtures.push(...chunkFixtures(seed, loopNumber, cx, cz, reserved))
    }
  }
  const result = {
    seed,
    loop: loopNumber,
    salt: loopSalt(loopNumber),
    reserved,
    objectives,
    chunks: CHUNKS,
    fixtures,
  }
  return { ...result, signature: fixtureSignature(result) }
}

/** Stable fingerprint of a whole fixture pass. */
export function fixtureSignature(pass) {
  return pass.fixtures
    .map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`)
    .join('|')
}


