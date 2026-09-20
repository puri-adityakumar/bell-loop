/**
 * maze.js — pure maze generation for THE BELL LOOP.
 *
 * No DOM, no Three.js, no globals: `verify.mjs` imports this file directly in
 * node and asserts the behaviour documented in PLAN.md section 4.
 *
 * Representation
 * --------------
 * GRID x GRID cells. `open[r][c]` is a 4-bit mask of OPEN passages
 * (N=1, E=2, S=4, W=8). The mask is symmetric: carving between two neighbours
 * sets the bit on both sides, so a cell can always be trusted alone.
 *
 * Generation (deterministic per loop number)
 * ------------------------------------------
 * 1. PRNG = mulberry32(loopNumber) — THE SEED IS THE LOOP NUMBER. A given loop
 *    therefore produces the exact same maze on every run, forever.
 * 2. Iterative recursive-backtracker over every cell EXCEPT the centre chamber
 *    (7,7): a perfect maze over the remaining 224 cells => 223 passages. The
 *    centre is excluded on purpose — sealing three of its four edges can then
 *    never disconnect the graph (a tree edge would).
 * 3. The centre chamber gets exactly ONE doorway, drawn from the same PRNG
 *    stream (`centerApproach`); its other three edges stay walled.
 * 4. EXTRA_CARVES (14) randomly chosen closed interior walls are knocked out,
 *    creating loops in the graph / multiple routes.
 * 5. Three shrine cells are drawn from the same PRNG stream, one from each of
 *    the three fixed ZONES (NW quadrant, NE quadrant, South band).
 */

export const GRID = 15
export const CELL_SIZE = 3.0
export const WALL_HEIGHT = 2.8
export const WALL_THICKNESS = 0.34

/**
 * Extra-carve rule, chosen so the maze stays a twisting labyrinth but every
 * cell stays walkable inside one 60s loop (documented in PLAN.md §4, item 3).
 *
 * After the backtracker + chamber door, BFS distances from the entrance are
 * measured and a shortcut wall is knocked out — always the closed interior wall
 * whose two sides differ most in distance, never one touching the chamber —
 * repeatedly until no cell is further than MAX_ENTRANCE_DEPTH steps away (or
 * EXTRA_CARVE_BUDGET walls have been opened). MIN_EXTRA_CARVES tops the count up
 * with plain random carves so the graph always has multiple routes.
 *
 * Measured over 2000 loops with the constants below: 0-24 carves (avg ~5.6),
 * worst-case entrance distance 48 steps (~144m), chamber door <= 46 steps, and
 * ~22 dead ends survive, so it still reads as a maze rather than a mesh.
 */
export const MAX_ENTRANCE_DEPTH = 45
export const EXTRA_CARVE_BUDGET = 60
export const MIN_EXTRA_CARVES = 3

/** Entrance = (0,0) corner. Exit chamber = centre cell (7,7). Never move. */
export const ENTRANCE = Object.freeze({ r: 0, c: 0 })
export const CENTER = Object.freeze({ r: 7, c: 7 })

/** Nothing (shrine) spawns inside the 8-neighbourhood of these landmarks. */
export const LANDMARK_CLEARANCE = 2

/**
 * Shrine fairness rule, measured in BFS steps from the entrance in the FINAL
 * graph (after the extra carves): each zone's shrine is drawn from the
 * `SHRINE_POOL` cells of that zone that are CLOSEST to the entrance.
 *
 * A recursive-backtracker maze is a deep tree — cells in a given quadrant can
 * be 80+ steps away — so a plain "random cell in the zone" rule would hide
 * shrines the player cannot reach inside one 60s loop. Taking the closest
 * quarter of a zone keeps a shrine roughly <= 35 steps (~105m, ~18s sprinting)
 * from the entrance while staying fully deterministic. MIN keeps shrines off
 * the doorstep.
 */
export const MIN_SHRINE_DISTANCE = 5
export const SHRINE_POOL = 24

/** Passage bits. */
export const N = 1
export const E = 2
export const S = 4
export const W = 8

export const DIRS = Object.freeze([
  Object.freeze({ name: 'N', bit: N, opposite: S, dr: -1, dc: 0 }),
  Object.freeze({ name: 'E', bit: E, opposite: W, dr: 0, dc: 1 }),
  Object.freeze({ name: 'S', bit: S, opposite: N, dr: 1, dc: 0 }),
  Object.freeze({ name: 'W', bit: W, opposite: E, dr: 0, dc: -1 }),
])

/** The three fixed shrine zones. Shrine identity (A/B/C) is welded to a zone. */
export const ZONES = Object.freeze([
  Object.freeze({ id: 'A', name: 'NW', minR: 0, maxR: 6, minC: 0, maxC: 6 }),
  Object.freeze({ id: 'B', name: 'NE', minR: 0, maxR: 6, minC: 8, maxC: 14 }),
  Object.freeze({ id: 'C', name: 'S', minR: 8, maxR: 14, minC: 0, maxC: 14 }),
])

export const SHRINE_IDS = Object.freeze(['A', 'B', 'C'])

/** Door-group yaw for each chamber approach, radians (see world.js). */
export const APPROACH_YAW = Object.freeze({
  N: 0,
  E: -Math.PI / 2,
  S: Math.PI,
  W: Math.PI / 2,
})

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — tiny, fast, well-distributed 32-bit PRNG.
 * @param {number} seed
 * @returns {() => number} generator returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function inGrid(r, c, size = GRID) {
  return r >= 0 && r < size && c >= 0 && c < size
}

export function isCenter(r, c) {
  return r === CENTER.r && c === CENTER.c
}

export function chebyshev(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c))
}

export function cellKey(r, c) {
  return r * GRID + c
}

/** Cell -> world position (x, z) of the cell centre. Maze is centred on origin. */
export function cellToWorld(r, c, size = GRID, cellSize = CELL_SIZE) {
  const half = (size - 1) / 2
  return { x: (c - half) * cellSize, z: (r - half) * cellSize }
}

export function isOpen(maze, r, c, dirBit) {
  if (!inGrid(r, c, maze.size)) return false
  return (maze.open[r][c] & dirBit) !== 0
}

/** True when a wall stands between cell (r,c) and its neighbour in `dir`. */
export function hasWall(maze, r, c, dir) {
  const nr = r + dir.dr
  const nc = c + dir.dc
  if (!inGrid(nr, nc, maze.size)) return true // outer boundary
  return (maze.open[r][c] & dir.bit) === 0
}

function shuffled(list, rng) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

/**
 * Build the maze for a given loop number. Pure + stateless: the result depends
 * on nothing but `loopNumber`.
 *
 * @param {number} loopNumber 1-based loop index; also the PRNG seed
 * @returns {object} maze layout (JSON-serialisable, no functions)
 */
export function generateMaze(loopNumber) {
  const loop = Math.max(1, Math.floor(loopNumber) || 1)
  const seed = loop
  const size = GRID
  const rng = mulberry32(seed)

  const open = []
  for (let r = 0; r < size; r++) open.push(new Array(size).fill(0))

  const carve = (r, c, dir) => {
    open[r][c] |= dir.bit
    open[r + dir.dr][c + dir.dc] |= dir.opposite
  }
  // the centre chamber is deliberately not part of the spanning tree
  const traversable = (r, c) => inGrid(r, c, size) && !isCenter(r, c)

  // --- 1. recursive backtracker (iterative stack), starting at the entrance
  const visited = new Set([cellKey(ENTRANCE.r, ENTRANCE.c)])
  const stack = [[ENTRANCE.r, ENTRANCE.c]]
  while (stack.length > 0) {
    const [r, c] = stack[stack.length - 1]
    const options = []
    for (const dir of DIRS) {
      const nr = r + dir.dr
      const nc = c + dir.dc
      if (traversable(nr, nc) && !visited.has(cellKey(nr, nc))) {
        options.push({ dir, nr, nc })
      }
    }
    if (options.length === 0) {
      stack.pop()
      continue
    }
    const pick = options[Math.floor(rng() * options.length)]
    carve(r, c, pick.dir)
    visited.add(cellKey(pick.nr, pick.nc))
    stack.push([pick.nr, pick.nc])
  }
  const treePassages = visited.size - 1

  // --- 2. exactly one doorway into the centre chamber
  const approach = shuffled(DIRS, rng)[0]
  carve(CENTER.r, CENTER.c, approach)

  // --- 3. extra carves: depth-limited shortcuts (see MAX_ENTRANCE_DEPTH above)
  // Every interior wall that does not touch the chamber, enumerated once.
  const candidates = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isCenter(r, c)) continue
      for (const dir of DIRS) {
        if (dir.bit !== E && dir.bit !== S) continue // each interior edge once
        const nr = r + dir.dr
        const nc = c + dir.dc
        if (!traversable(nr, nc)) continue
        candidates.push({ r, c, dir })
      }
    }
  }

  let extraCarved = 0
  let dist = distanceMap({ open, size }, ENTRANCE)
  while (extraCarved < EXTRA_CARVE_BUDGET) {
    let deepest = 0
    for (const d of dist.values()) if (d > deepest) deepest = d
    if (deepest <= MAX_ENTRANCE_DEPTH) break
    let best = null
    for (const cand of candidates) {
      if ((open[cand.r][cand.c] & cand.dir.bit) !== 0) continue
      const nr = cand.r + cand.dir.dr
      const nc = cand.c + cand.dir.dc
      const da = dist.get(cellKey(cand.r, cand.c))
      const db = dist.get(cellKey(nr, nc))
      if (da === undefined || db === undefined) continue
      if (Math.max(da, db) <= MAX_ENTRANCE_DEPTH) continue
      const score = Math.abs(da - db)
      if (best === null || score > best.score) best = { score, cand }
    }
    if (best === null) break
    carve(best.cand.r, best.cand.c, best.cand.dir)
    extraCarved += 1
    dist = distanceMap({ open, size }, ENTRANCE)
  }
  // flavour floor: always leave at least MIN_EXTRA_CARVES loops in the graph
  if (extraCarved < MIN_EXTRA_CARVES) {
    for (const cand of shuffled(candidates, rng)) {
      if (extraCarved >= MIN_EXTRA_CARVES) break
      if ((open[cand.r][cand.c] & cand.dir.bit) !== 0) continue
      carve(cand.r, cand.c, cand.dir)
      extraCarved += 1
    }
  }

  // --- 4. one shrine per fixed zone (same PRNG stream, so fully determined)
  // Candidate pools are ranked by distance from the entrance in the FINAL graph
  // and truncated to the closest SHRINE_POOL cells, so a shrine is always
  // genuinely reachable inside one 60s loop (see SHRINE_POOL above).
  const shrineDist = distanceMap({ open, size }, ENTRANCE)
  const shrineCells = {}
  for (const zone of ZONES) {
    const pool = []
    for (let r = zone.minR; r <= zone.maxR; r++) {
      for (let c = zone.minC; c <= zone.maxC; c++) {
        if (isCenter(r, c)) continue
        if (chebyshev({ r, c }, ENTRANCE) < LANDMARK_CLEARANCE) continue
        if (chebyshev({ r, c }, CENTER) < LANDMARK_CLEARANCE) continue
        const d = shrineDist.get(cellKey(r, c))
        if (d === undefined || d < MIN_SHRINE_DISTANCE) continue
        pool.push({ r, c, d })
      }
    }
    // deterministic: sort by distance, then by enumeration order for ties
    pool.sort((a, b) => a.d - b.d)
    const trimmed = pool.slice(0, SHRINE_POOL)
    const pick = trimmed[Math.floor(rng() * trimmed.length)]
    shrineCells[zone.id] = { r: pick.r, c: pick.c }
  }

  // --- 5. flat wall-segment list (AABBs for collision, matrices for instances)
  const walls = []
  const halfSpan = (CELL_SIZE + WALL_THICKNESS) / 2
  const halfThick = WALL_THICKNESS / 2
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const { x, z } = cellToWorld(r, c, size)
      // horizontal walls (long axis X) sit on the north / south edges
      if (r === 0) {
        walls.push({ axis: 'x', cx: x, cz: z - CELL_SIZE / 2, hx: halfSpan, hz: halfThick, r, c, edge: 'N' })
      }
      if (r === size - 1 || (open[r][c] & S) === 0) {
        walls.push({ axis: 'x', cx: x, cz: z + CELL_SIZE / 2, hx: halfSpan, hz: halfThick, r, c, edge: 'S' })
      }
      // vertical walls (long axis Z) sit on the west / east edges
      if (c === 0) {
        walls.push({ axis: 'z', cx: x - CELL_SIZE / 2, cz: z, hx: halfThick, hz: halfSpan, r, c, edge: 'W' })
      }
      if (c === size - 1 || (open[r][c] & E) === 0) {
        walls.push({ axis: 'z', cx: x + CELL_SIZE / 2, cz: z, hx: halfThick, hz: halfSpan, r, c, edge: 'E' })
      }
    }
  }

  return {
    loop,
    seed,
    size,
    cellSize: CELL_SIZE,
    wallHeight: WALL_HEIGHT,
    wallThickness: WALL_THICKNESS,
    open,
    shrineCells,
    centerApproach: approach.name,
    entrance: { r: ENTRANCE.r, c: ENTRANCE.c },
    center: { r: CENTER.r, c: CENTER.c },
    treePassages,
    extraCarved,
    walls,
  }
}

// ---------------------------------------------------------------------------
// graph queries (used by verify.mjs and by the game's win/prompt logic)
// ---------------------------------------------------------------------------

/** BFS over open passages. Returns the set of reachable cell keys. */
export function reachableCells(maze, from = maze.entrance) {
  const seen = new Set([cellKey(from.r, from.c)])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const dir of DIRS) {
      if ((maze.open[cur.r][cur.c] & dir.bit) === 0) continue
      const key = cellKey(cur.r + dir.dr, cur.c + dir.dc)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push({ r: cur.r + dir.dr, c: cur.c + dir.dc })
    }
  }
  return seen
}

/** BFS step count from `from` to every reachable cell: Map<cellKey, steps>. */
export function distanceMap(maze, from = maze.entrance) {
  const dist = new Map([[cellKey(from.r, from.c), 0]])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()
    const d = dist.get(cellKey(cur.r, cur.c))
    for (const dir of DIRS) {
      if ((maze.open[cur.r][cur.c] & dir.bit) === 0) continue
      const nr = cur.r + dir.dr
      const nc = cur.c + dir.dc
      const key = cellKey(nr, nc)
      if (dist.has(key)) continue
      dist.set(key, d + 1)
      queue.push({ r: nr, c: nc })
    }
  }
  return dist
}

export function hasPath(maze, from, to) {
  return reachableCells(maze, from).has(cellKey(to.r, to.c))
}

/** Shortest route in cells between two cells (BFS); -1 when unreachable. */
export function pathLength(maze, from, to) {
  const target = cellKey(to.r, to.c)
  const dist = new Map([[cellKey(from.r, from.c), 0]])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()
    const d = dist.get(cellKey(cur.r, cur.c))
    if (cellKey(cur.r, cur.c) === target) return d
    for (const dir of DIRS) {
      if ((maze.open[cur.r][cur.c] & dir.bit) === 0) continue
      const nr = cur.r + dir.dr
      const nc = cur.c + dir.dc
      const key = cellKey(nr, nc)
      if (dist.has(key)) continue
      dist.set(key, d + 1)
      queue.push({ r: nr, c: nc })
    }
  }
  return -1
}

/** Number of undirected open passages in the graph. */
export function openEdgeCount(maze) {
  let count = 0
  for (let r = 0; r < maze.size; r++) {
    for (let c = 0; c < maze.size; c++) {
      const mask = maze.open[r][c]
      if (mask & N) count += 1
      if (mask & E) count += 1
      if (mask & S) count += 1
      if (mask & W) count += 1
    }
  }
  return count / 2
}

/** Stable fingerprint of a layout — proves determinism / distinctness. */
export function mazeSignature(maze) {
  const rows = maze.open.map((row) => row.join('')).join('|')
  const shrines = SHRINE_IDS.map((id) => {
    const cell = maze.shrineCells[id]
    return `${id}:${cell.r},${cell.c}`
  }).join('|')
  return `${maze.seed}#${maze.centerApproach}#${rows}#${shrines}`
}

export default generateMaze
