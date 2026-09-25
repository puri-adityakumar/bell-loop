#!/usr/bin/env node
/**
 * verify.mjs — node-side assertions over the PURE game modules
 * (`src/game/maze.js` and the reducers in `src/game/loop.js`).
 *
 * The browser game cannot be clicked by a script, so this file proves the parts
 * that are testable headlessly:
 *   - the PRNG is deterministic and the seed really is the loop number
 *   - every loop's maze is fully connected and byte-identical on re-generation
 *   - the centre chamber always has exactly one doorway, matching centerApproach
 *   - the three shrines are always one per documented zone, distinct, clear of
 *     the landmarks, and reachable inside a single 60s loop
 *   - wall segments exactly cover every closed edge (no gaps, no phantoms)
 *   - the candle / door / timer / bell-timeline rules in loop.js
 *
 * Run: node verify.mjs   (exit code 0 = all green)
 */
import assert from 'node:assert/strict'
import {
  generateMaze,
  mulberry32,
  mazeSignature,
  reachableCells,
  hasPath,
  pathLength,
  distanceMap,
  openEdgeCount,
  hasWall,
  cellKey,
  cellToWorld,
  chebyshev,
  GRID,
  CELL_SIZE,
  WALL_HEIGHT,
  WALL_THICKNESS,
  MAX_ENTRANCE_DEPTH,
  MIN_EXTRA_CARVES,
  EXTRA_CARVE_BUDGET,
  LANDMARK_CLEARANCE,
  MIN_SHRINE_DISTANCE,
  SHRINE_POOL,
  ZONES,
  SHRINE_IDS,
  ENTRANCE,
  CENTER,
  DIRS,
  E,
  S,
  APPROACH_YAW,
} from './src/game/maze.js'
// v2 slice 01. `maze.js` still exports its own `mulberry32` for v1 and that is
// untouched until slice 16 deletes it, so the two are imported under distinct
// names here — the temporary duplication stays visible instead of silent.
import {
  hash32,
  streamAt,
  mulberry32 as mulberry32V2,
} from './src/game/hash.js'
// v2 slice 02. Imported as a namespace because GRID, BLOCK and the BFS helper
// names all collide with v1's maze.js exports; slice 16 removes that overlap for
// good, and until then the v2 world reads `hood.*` beside v1's flat names.
import * as hood from './src/game/neighborhood.js'
import {
  LOOP_SECONDS,
  PHASE,
  RESET_TIMELINE,
  RESET_SWAP_AT,
  createInitialState,
  candlesLit,
  allCandlesLit,
  shouldDoorOpenAtLoopStart,
  applyLightCandle,
  advanceTimer,
  beginLoop,
  restartState,
  resetFade,
  wallRiseProgress,
  wallRiseDelay,
  createStore,
  hudSnapshot,
  DOOR_WIN_RADIUS,
  isInsideChamber,
} from './src/game/loop.js'

const VERIFY_LOOPS = [1, 2, 3, 4, 5, 6, 7, 8]
const WALK_SPEED = 3.6 // m/s, PlayerController default

const sections = []
let current = null
let passed = 0
let failed = 0

function section(title) {
  current = { title, tests: [] }
  sections.push(current)
}

function test(name, fn) {
  if (!current) section('ungrouped')
  try {
    fn()
    passed += 1
    current.tests.push({ name, ok: true })
  } catch (error) {
    failed += 1
    current.tests.push({ name, ok: false, error: error.message })
  }
}

/** Population count of `a ^ b` — how many of the 32 bits differ. */
function hamming32(a, b) {
  let x = (a ^ b) >>> 0
  let count = 0
  while (x) {
    x &= x - 1
    count += 1
  }
  return count
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// v2 slice 01 — random-access hashing
// ---------------------------------------------------------------------------

section('Random-access hashing (v2 slice 01)')

test('hash32 is reproducible and stays an unsigned 32-bit integer', () => {
  for (let seed = 0; seed < 32; seed++) {
    for (let cx = 0; cx < 8; cx++) {
      for (let cz = 0; cz < 8; cz++) {
        const first = hash32(seed, cx, cz)
        assert.equal(hash32(seed, cx, cz), first, `hash32(${seed},${cx},${cz}) is not reproducible`)
        assert.equal(hash32(seed, cx, cz), first, 'a third call drifted')
        assert.ok(Number.isInteger(first), 'hash32 must return an integer')
        assert.ok(first >= 0 && first <= 0xffffffff, `out of range: ${first}`)
      }
    }
  }
})

test('hash32 is well distributed across both the high and the low bits', () => {
  // A weak mix usually avalanches the top bits and leaves the bottom ones
  // nearly untouched, so both ends get their own bucket test. Uniformity is
  // asserted with a chi-square statistic rather than a hand-tuned per-bucket
  // tolerance: 16 buckets is 15 degrees of freedom, where 30.6 is p < 0.01.
  //
  // Measured against weaker alternatives at this threshold, so the test is not
  // merely passing its own output: the additive hash scores 20.3, the XOR
  // combiner 146.0, a single fmix32 round 112.8, and `seed ^ cx ^ cz` 122880.
  const STRIDES = [1, 7, 13, 101, 4096, 65537]
  const CHI2_LIMIT = 30.6 // 15 df, p < 0.01
  for (const stride of STRIDES) {
    const high = new Array(16).fill(0)
    const low = new Array(16).fill(0)
    let samples = 0
    for (let seed = 0; seed < 8; seed++) {
      for (let cx = 0; cx < 32; cx++) {
        for (let cz = 0; cz < 32; cz++) {
          const h = hash32(seed * stride, cx, cz)
          high[(h >>> 28) & 15] += 1
          low[h & 15] += 1
          samples += 1
        }
      }
    }
    // per stride, not cumulative: each pass is its own 8192-sample experiment
    assert.equal(samples, 8192)
    const expected = samples / 16
    const chiSquare = (buckets) =>
      buckets.reduce((sum, n) => sum + ((n - expected) * (n - expected)) / expected, 0)
    for (const [name, buckets] of [['high', high], ['low', low]]) {
      const stat = chiSquare(buckets)
      assert.ok(
        stat < CHI2_LIMIT,
        `${name} bits are not uniform at stride ${stride}: chi-square ${stat.toFixed(1)} over 15 df`,
      )
    }
  }
})

test('the same (seed, cx, cz) always yields the same stream', () => {
  const coords = [
    [0, 0, 0],
    [1, 3, 4],
    [1337, 6, 6],
    [0xffffffff, 12, 40],
    [-1, -2, -3],
  ]
  for (const [seed, cx, cz] of coords) {
    const a = streamAt(seed, cx, cz)
    const b = streamAt(seed, cx, cz)
    for (let i = 0; i < 1000; i++) {
      const value = a()
      assert.equal(value, b(), `stream ${i} diverged for (${seed},${cx},${cz})`)
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
    }
  }
  // the exported generator is the same one streamAt drives
  const direct = mulberry32V2(hash32(1337, 6, 6))
  const viaStream = streamAt(1337, 6, 6)
  for (let i = 0; i < 64; i++) assert.equal(direct(), viaStream())
})

test('distinct chunk coordinates yield distinct streams', () => {
  const seen = new Map()
  let checked = 0
  // negative coordinates included: the wrap in §3.3 folds them into range
  for (let seed = 0; seed < 4; seed++) {
    for (let cx = -4; cx < 8; cx++) {
      for (let cz = -4; cz < 8; cz++) {
        const rng = streamAt(seed, cx, cz)
        const signature = Array.from({ length: 6 }, () => rng().toFixed(12)).join(',')
        const key = `${seed}:${cx}:${cz}`
        assert.ok(!seen.has(signature), `collision between ${seen.get(signature)} and ${key}`)
        seen.set(signature, key)
        checked += 1
      }
    }
  }
  assert.equal(checked, 4 * 12 * 12)
  assert.equal(seen.size, checked, 'every coordinate must have its own stream')
})

test('adjacent cx values avalanche instead of clustering', () => {
  // THE test for this slice. A weak mix leaves neighbouring chunks a couple of
  // bits apart, which reads in game as visibly repeating streets down every row.
  // Two independent 32-bit values differ in 16 bits on average.
  const distances = []
  for (let seed = 0; seed < 16; seed++) {
    for (let cz = 0; cz < 16; cz++) {
      for (let cx = 0; cx < 32; cx++) {
        distances.push(hamming32(hash32(seed, cz * 7919, cx), hash32(seed, cz * 7919, cx + 1)))
      }
    }
  }
  const average = mean(distances)
  const closest = Math.min(...distances)
  const farthest = Math.max(...distances)
  assert.equal(distances.length, 16 * 16 * 32)
  assert.ok(average > 12, `adjacent chunks average only ${average.toFixed(2)} bits apart — clustering`)
  assert.ok(average < 20, `adjacent chunks average ${average.toFixed(2)} bits apart — implausibly diffuse`)
  assert.ok(closest >= 4, `the closest adjacent pair is only ${closest} bits apart`)
  assert.ok(farthest <= 28, `the furthest adjacent pair is ${farthest} bits apart`)
})

test('adjacent streams diverge as fast as unrelated streams do', () => {
  // The bit-level test above could pass while the streams themselves stayed
  // correlated, so compare neighbours against a control population of streams
  // that are deliberately far apart. Two independent uniforms differ by 1/3 on
  // average; a clustering hash pulls the adjacent figure under the control.
  const adjacent = []
  const control = []
  for (let cz = 0; cz < 32; cz++) {
    for (let cx = 0; cx < 32; cx++) {
      const here = streamAt(7, cx, cz)
      const next = streamAt(7, cx + 1, cz)
      const far = streamAt(7, cx + 32, cz)
      adjacent.push(Math.abs(here() - next()))
      control.push(Math.abs(here() - far()))
    }
  }
  const adjacentMean = mean(adjacent)
  const controlMean = mean(control)
  assert.ok(controlMean > 0.25 && controlMean < 0.42, `control mean looks wrong: ${controlMean}`)
  assert.ok(
    adjacentMean > controlMean * 0.8,
    `neighbouring streams differ by ${adjacentMean.toFixed(4)} vs control ${controlMean.toFixed(4)} — clustering`,
  )
  assert.ok(
    adjacentMean < controlMean * 1.2,
    `neighbouring streams differ by ${adjacentMean.toFixed(4)} vs control ${controlMean.toFixed(4)} — implausible`,
  )
})

test('chunk streams are independent of the order they are generated in', () => {
  // The property that makes deferred streaming a change to `resolveChunk`
  // instead of a rewrite: nothing is shared between chunks.
  const signature = (seed, cx, cz) => {
    const rng = streamAt(seed, cx, cz)
    return Array.from({ length: 8 }, () => rng().toFixed(12)).join(',')
  }
  const forward = []
  for (let cx = 0; cx < 16; cx++) {
    for (let cz = 0; cz < 16; cz++) forward.push(signature(1337, cx, cz))
  }
  // `forward` is filled cx-outer/cz-inner, so its index is cx * 16 + cz
  const backward = new Array(forward.length)
  for (let cx = 15; cx >= 0; cx--) {
    for (let cz = 15; cz >= 0; cz--) backward[cx * 16 + cz] = signature(1337, cx, cz)
  }
  assert.equal(forward.length, 256)
  assert.equal(new Set(forward).size, 256, 'two chunks shared a stream')
  assert.deepEqual(backward, forward, 'generating chunks in a different order changed their content')

  // and a different seed is a different world rather than a shifted one
  const base = streamAt(1, 0, 0)
  const other = streamAt(2, 0, 0)
  assert.notEqual(base(), other(), 'two seeds produced the same first value')
})

// ---------------------------------------------------------------------------
// v2 slice 02 — chunks, wrap, street graph
// ---------------------------------------------------------------------------

section('Neighborhood chunks + wrap (v2 slice 02)')

test('the slice 02 constants match the design', () => {
  assert.equal(hood.GRID, 7, 'GAMEDESIGN.md §3.1 fixes a 7 x 7 block grid')
  assert.equal(hood.BLOCK, 64, 'GAMEDESIGN.md §3.1 fixes 64 m blocks')
  assert.equal(hood.WORLD_EXTENT, 448)
  assert.equal(hood.WORLD_HALF, 224)
  assert.equal(hood.CHUNKS, 49)
  assert.equal(hood.INTERSECTIONS, 49)
  assert.equal(hood.DISTRICTS, 4)
  assert.equal(hood.SIDE_NAMES.length, 4)
  assert.equal(hood.streetEdgeCount(), 98, '49 nodes x 4 neighbours / 2')
})

test('wrap folds negatives and multiples into range', () => {
  assert.equal(hood.wrap(-1, 7), 6, 'plain % would return -1 here')
  assert.equal(hood.wrap(-7, 7), 0)
  assert.equal(hood.wrap(-8, 7), 6)
  assert.equal(hood.wrap(7, 7), 0)
  for (let v = -50; v <= 50; v++) {
    const folded = hood.wrap(v, 7)
    assert.ok(folded >= 0 && folded < 7, `wrap(${v}, 7) = ${folded} is out of range`)
    assert.equal(hood.wrap(folded, 7), folded, 'wrapping twice must be stable')
    // normalised, because `(0 - 7) % 7` is -0 and assert.strictEqual compares
    // with Object.is, under which -0 and 0 are different values
    assert.equal(
      ((folded - v) % hood.GRID + hood.GRID) % hood.GRID,
      0,
      `wrap(${v}, 7) is not congruent to the input`,
    )
  }
})

test('the same (seed, cx, cz) always yields the same signature', () => {
  const forward = new Array(hood.CHUNKS)
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      forward[cz * hood.GRID + cx] = hood.chunkAt(1337, cx, cz).signature
    }
  }
  // regenerate all 49 in reverse, interleaved with other seeds, so a stream
  // accidentally shared between chunks would show up as drift
  const backward = new Array(hood.CHUNKS)
  for (let cx = hood.GRID - 1; cx >= 0; cx--) {
    for (let cz = hood.GRID - 1; cz >= 0; cz--) {
      hood.chunkAt(999, cx, cz)
      hood.chunkAt(42, cx, 0)
      backward[cz * hood.GRID + cx] = hood.chunkAt(1337, cx, cz).signature
    }
  }
  assert.equal(new Set(forward).size, hood.CHUNKS, 'two chunks in one seed shared a signature')
  assert.deepEqual(backward, forward, 'regenerating a chunk produced different content')
})

test('chunk generation order cannot affect any chunk', () => {
  const reference = new Map()
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) reference.set(`${cx},${cz}`, hood.chunkAt(7, cx, cz).signature)
  }
  // visit every chunk in a stride-5 permutation of the flattened index, twice,
  // so nothing can depend on being generated first
  const order = []
  for (let k = 0; k < hood.CHUNKS; k++) order.push((k * 5) % hood.CHUNKS)
  assert.equal(new Set(order).size, hood.CHUNKS, 'the stride permutation must visit every chunk once')
  for (let pass = 0; pass < 2; pass++) {
    for (const index of order) {
      const cx = Math.floor(index / hood.GRID)
      const cz = index % hood.GRID
      assert.equal(
        hood.chunkAt(7, cx, cz).signature,
        reference.get(`${cx},${cz}`),
        `chunk ${cx},${cz} changed on pass ${pass}`,
      )
    }
  }
})

test('out-of-range coordinates generate deterministically and never depend on wrap state', () => {
  // the same block, reached two ways: the folded parts must agree
  const negative = hood.chunkAt(1337, -1, 5)
  const positive = hood.chunkAt(1337, 6, 5)
  assert.equal(negative.key, positive.key, 'cx = -1 must name the same block as cx = 6')
  assert.equal(negative.district, positive.district)
  assert.deepEqual(negative.corners, positive.corners)
  assert.deepEqual(negative.centre, positive.centre)
  // ...but they are DIFFERENT chunks with different streams. This is the
  // contract that makes deferred streaming a one-line change: when the world
  // stops wrapping, -1 becomes a real chunk beside 0 instead of a copy of it.
  assert.notEqual(negative.signature, positive.signature, 'unfolded coordinates must not share a stream')

  for (const [cx, cz] of [[-1, 5], [-21, -21], [27, 13], [1000000, -1000000], [-99999, 99999]]) {
    assert.equal(
      hood.chunkAt(1337, cx, cz).signature,
      hood.chunkAt(1337, cx, cz).signature,
      `chunk ${cx},${cz} is not reproducible`,
    )
    assert.equal(
      hood.chunkKey(cx, cz),
      hood.chunkKey(cx + hood.GRID, cz - hood.GRID),
      'folding must be periodic in both axes',
    )
  }

  // every coordinate in a wide band folds to the block it names
  for (let cx = -21; cx <= 27; cx++) {
    for (let cz = -21; cz <= 27; cz++) {
      const chunk = hood.chunkAt(1337, cx, cz)
      const key = hood.resolveChunk(cx, cz)
      assert.equal(chunk.key, key.cx * hood.GRID + key.cz, `chunk ${cx},${cz} has the wrong key`)
      assert.equal(chunk.district, hood.districtOf(cx, cz), `chunk ${cx},${cz} is in the wrong district`)
      assert.equal(chunk.cx, cx, 'chunkAt must report the coordinate it was asked for')
      assert.equal(chunk.cz, cz)
    }
  }
})

test('the street graph is connected across the wrap seam in all four directions', () => {
  // the four seam crossings exist as real edges, in both directions, everywhere
  for (let i = 0; i < hood.GRID; i++) {
    const last = hood.streetNodeId(hood.GRID - 1, i)
    const first = hood.streetNodeId(0, i)
    assert.ok(hood.STREET_ADJ[last].includes(first), `no east seam edge on row ${i}`)
    assert.ok(hood.STREET_ADJ[first].includes(last), `no west seam edge on row ${i}`)
    const lastCol = hood.streetNodeId(i, hood.GRID - 1)
    const firstCol = hood.streetNodeId(i, 0)
    assert.ok(hood.STREET_ADJ[lastCol].includes(firstCol), `no south seam edge on column ${i}`)
    assert.ok(hood.STREET_ADJ[firstCol].includes(lastCol), `no north seam edge on column ${i}`)
  }
  // one connected component, from every start. Note this alone does NOT prove
  // the wrap: a plain 7 x 7 grid is 49/49 reachable too. The distance test below
  // is what actually proves it. Both stay, because they fail for different
  // reasons — a missing seam edge breaks this, a missing fold breaks that.
  for (let start = 0; start < hood.INTERSECTIONS; start++) {
    assert.equal(
      hood.reachableIntersections(start).size,
      hood.INTERSECTIONS,
      `node ${start} cannot reach the whole map`,
    )
  }
  // crossing a seam costs exactly one step, in every direction
  const at = (ax, az) => ({ ax, az })
  assert.equal(hood.streetPathLength(at(0, 0), at(6, 0)), 1, 'east seam')
  assert.equal(hood.streetPathLength(at(6, 0), at(0, 0)), 1, 'west seam')
  assert.equal(hood.streetPathLength(at(0, 0), at(0, 6)), 1, 'south seam')
  assert.equal(hood.streetPathLength(at(0, 6), at(0, 0)), 1, 'north seam')
  // a diagonal that needs BOTH seams at once
  assert.equal(hood.streetPathLength(at(6, 6), at(0, 0)), 2, 'both seams')
  assert.equal(hood.streetPathLength(at(0, 0), at(3, 3)), 6, 'opposite corner of the torus')
  assert.equal(hood.hasStreetPath(at(6, 6), at(0, 0)), true)
})

test('the wrap is real: the map is 6 steps across, not 12', () => {
  // An unwrapped 7 x 7 grid is 12 steps corner to corner. A wrapped one is
  // floor(7/2) + floor(7/2) = 6. If the fold ever breaks, this says so — and
  // unlike a visual check, it cannot be missed in a screenshot.
  let worst = 0
  for (let start = 0; start < hood.INTERSECTIONS; start++) {
    const dist = hood.streetDistanceMap(start)
    assert.ok(
      Array.from(dist).every((d) => d >= 0),
      `node ${start} cannot reach part of the map`,
    )
    worst = Math.max(worst, ...dist)
  }
  assert.equal(worst, 6, 'the world is not wrapping — far corners are further apart than the torus allows')
})

test('world and chunk coordinates round trip', () => {
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      const centre = hood.blockCentre(cx, cz)
      const back = hood.chunkAtWorld(centre.x, centre.z)
      assert.equal(back.cx, cx, `block ${cx},${cz} centre resolves to ${back.cx},${back.cz}`)
      assert.equal(back.cz, cz)
      // and so does any point inside the block, which is what the renderer
      // relies on when it works out which chunk a moving player is in
      for (const d of [-hood.BLOCK / 2 + 1, -1, 0, 1, hood.BLOCK / 2 - 1]) {
        const inner = hood.chunkAtWorld(centre.x + d, centre.z + d)
        assert.equal(inner.cx, cx, `point ${d} inside block ${cx},${cz} resolved elsewhere`)
        assert.equal(inner.cz, cz)
      }
    }
  }
  // the unfolded centre of the last block sits exactly one period past the fold
  assert.equal(hood.blockCentre(hood.GRID - 1, hood.GRID - 1).x, hood.WORLD_HALF)
  assert.equal(hood.blockCentre(hood.GRID - 1, hood.GRID - 1).z, hood.WORLD_HALF)
})

test('the BFS helpers agree with each other', () => {
  for (let from = 0; from < hood.INTERSECTIONS; from++) {
    const dist = hood.streetDistanceMap(from)
    const seen = hood.reachableIntersections(from)
    for (let to = 0; to < hood.INTERSECTIONS; to++) {
      const length = hood.streetPathLength(from, to)
      assert.equal(length, dist[to], `pathLength(${from},${to}) disagrees with distanceMap`)
      assert.equal(hood.hasStreetPath(from, to), length >= 0)
      assert.equal(seen.has(to), dist[to] >= 0)
    }
  }
  assert.equal(hood.streetPathLength({ ax: 3, az: 3 }, { ax: 3, az: 3 }), 0, 'a node is zero steps from itself')
  assert.equal(hood.streetNodeId(9, 9), hood.streetNodeId(2, 2), 'node ids must fold')
  assert.deepEqual(hood.streetNodeCoords(hood.streetNodeId(9, 9)), { ax: 2, az: 2 })
  assert.equal(hood.streetEdgeCount(), 98)
})

test('every block fronts streets, and the four districts cover the world', () => {
  const counts = new Array(hood.DISTRICTS).fill(0)
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) {
      const chunk = hood.chunkAt(1337, cx, cz)
      counts[chunk.district] += 1
      assert.equal(chunk.corners.length, 4)
      assert.equal(new Set(chunk.corners).size, 4, `block ${cx},${cz} has a repeated corner`)
      // all four corners reach each other, so every side fronts a real street
      for (const corner of chunk.corners) {
        for (const other of chunk.corners) {
          assert.ok(hood.hasStreetPath(corner, other), `corner ${corner} cannot reach ${other}`)
        }
      }
      // lots sit strictly inside their block — that is what makes the slice 04
      // rule "no fixture on a street cell" easy to state and to assert
      assert.equal(chunk.lots.length, 4)
      for (const lot of chunk.lots) {
        assert.ok(hood.LOT_KINDS.includes(lot.kind), `unknown lot kind ${lot.kind}`)
        assert.ok(lot.tint >= 0 && lot.tint < 4, `tint ${lot.tint} is out of range`)
        assert.ok(
          Math.abs(lot.x - chunk.centre.x) + lot.w / 2 <= hood.BLOCK / 2,
          `lot ${lot.side} pokes outside block ${cx},${cz} on x`,
        )
        assert.ok(
          Math.abs(lot.z - chunk.centre.z) + lot.d / 2 <= hood.BLOCK / 2,
          `lot ${lot.side} pokes outside block ${cx},${cz} on z`,
        )
      }
    }
  }
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    hood.CHUNKS,
    'every block must belong to exactly one district',
  )
  for (let d = 0; d < hood.DISTRICTS; d++) {
    assert.ok(counts[d] > 0, `district ${d} has no blocks`)
  }
})

// ---------------------------------------------------------------------------
// v2 slice 03 — districts and objective anchors
// ---------------------------------------------------------------------------

section('Objective anchors (v2 slice 03)')

/** Closest approach of a world point to any road centreline, in metres. */
function distanceToNearestRoad(x, z) {
  const dx = Math.abs(x / hood.BLOCK - Math.round(x / hood.BLOCK)) * hood.BLOCK
  const dz = Math.abs(z / hood.BLOCK - Math.round(z / hood.BLOCK)) * hood.BLOCK
  return Math.min(dx, dz)
}

test('the slice 03 constants match the design', () => {
  assert.equal(hood.MIN_OBJECTIVE_DISTANCE, 3, '§3.4 keeps objectives a real walk from spawn')
  assert.equal(hood.OBJECTIVE_POOL, 6, '§3.4 caps the nearest-N candidate pool')
  assert.equal(hood.MIN_ANCHOR_SEPARATION, 2, 'no two objectives on adjacent blocks')
  assert.deepEqual([...hood.PORTAL_IDS], ['A', 'B', 'C'])
  assert.deepEqual([...hood.ANCHOR_IDS], ['A', 'B', 'C', 'HAMMER', 'EXIT'])
  // spawn is a fixed point, like v1's ENTRANCE — the distances mean nothing if it moves
  assert.equal(hood.SPAWN.cx, 0)
  assert.equal(hood.SPAWN.cz, 0)
  assert.equal(hood.chunkAtWorld(hood.SPAWN.position.x, hood.SPAWN.position.z).cx, 0)
  assert.equal(hood.districtOf(hood.SPAWN.cx, hood.SPAWN.cz), 0)
})

test('every district hosts exactly one objective, and identity is welded to it', () => {
  assert.equal(Object.keys(hood.OBJECTIVE_DISTRICT).length, 4)
  assert.deepEqual(
    hood.PORTAL_IDS.map((id) => hood.OBJECTIVE_DISTRICT[id]).sort(),
    [0, 1, 2],
    'the three portals take three distinct districts',
  )
  const districts = hood.PORTAL_IDS.map((id) => hood.OBJECTIVE_DISTRICT[id]).concat(hood.OBJECTIVE_DISTRICT.HAMMER)
  assert.equal(new Set(districts).size, 4, 'the four district objectives must be one per district')

  for (let seed = 1; seed <= 64; seed++) {
    const objectives = hood.placeObjectives(seed, 1)
    for (const anchor of [...objectives.portals, objectives.hammer]) {
      assert.equal(
        anchor.district,
        hood.OBJECTIVE_DISTRICT[anchor.id],
        `seed ${seed}: ${anchor.id} is in district ${anchor.district}, expected ${hood.OBJECTIVE_DISTRICT[anchor.id]}`,
      )
      assert.equal(anchor.district, hood.districtOf(anchor.chunk.cx, anchor.chunk.cz))
    }
    assert.equal(objectives.exit.district, null, 'the exit is deliberately not district-allocated')
    // the five objectives never share a block
    assert.equal(new Set(objectives.all.map((a) => a.chunk.cx + ',' + a.chunk.cz)).size, 5)
  }
})

test('every anchor sits on a lot, never on a street', () => {
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      const chunk = hood.chunkAt(seed, anchor.chunk.cx, anchor.chunk.cz)
      const lot = chunk.lots.find((candidate) => candidate.side === anchor.lot.side)
      assert.ok(lot, `seed ${seed}: ${anchor.id} names a lot that does not exist`)
      assert.equal(anchor.position.x, lot.x, `${anchor.id} is not on its lot`)
      assert.equal(anchor.position.z, lot.z)
      // and that lot is strictly inside the block, clear of the road centreline
      assert.ok(
        Math.abs(anchor.position.x - chunk.centre.x) + lot.w / 2 <= hood.BLOCK / 2,
        `${anchor.id} pokes out of its block`,
      )
      assert.ok(
        distanceToNearestRoad(anchor.position.x, anchor.position.z) >= hood.SETBACK,
        `${anchor.id} is on the street, not on a lot`,
      )
    }
  }
})


test('objectives respect the distance floor and the nearest-N pool ceiling', () => {
  const pools = hood.objectiveCandidates()
  assert.equal(pools.length, hood.DISTRICTS)
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      assert.ok(
        anchor.distance >= hood.MIN_OBJECTIVE_DISTANCE,
        `seed ${seed}: ${anchor.id} is ${anchor.distance} steps from spawn, inside the ${hood.MIN_OBJECTIVE_DISTANCE}-step floor`,
      )
      assert.equal(
        anchor.distance,
        hood.blockDistanceFromSpawn(anchor.chunk.cx, anchor.chunk.cz),
        `${anchor.id} reports the wrong distance`,
      )
      // the exit is not district-allocated, so it has no pool to rank within
      if (anchor.kind === 'exit') continue
      // drawn from the nearest-N of its own district's eligible blocks
      const pool = pools[hood.OBJECTIVE_DISTRICT[anchor.id]]
      const rank = pool.findIndex((block) => block.cx === anchor.chunk.cx && block.cz === anchor.chunk.cz)
      assert.ok(rank >= 0, `seed ${seed}: ${anchor.id} is not in its district's candidate pool`)
      assert.ok(
        rank < hood.OBJECTIVE_POOL,
        `seed ${seed}: ${anchor.id} came from rank ${rank}, past the pool of ${hood.OBJECTIVE_POOL}`,
      )
    }
  }
  // eligibility is structural, so the pools are identical every run
  assert.deepEqual(hood.objectiveCandidates(), hood.objectiveCandidates())
  assert.equal(pools.reduce((n, pool) => n + pool.length, 0), 25, '25 of 49 blocks clear the 3-step floor')
})

test('the hammer is separated from every portal by construction', () => {
  for (let seed = 1; seed <= 128; seed++) {
    const objectives = hood.placeObjectives(seed, 1)
    for (const portal of objectives.portals) {
      assert.ok(
        portal.separation >= hood.MIN_ANCHOR_SEPARATION,
        `seed ${seed}: ${portal.id} is only ${portal.separation} blocks from the hammer`,
      )
      assert.equal(
        portal.separation,
        hood.blockCentreDistance(portal.chunk, objectives.hammer.chunk),
        `${portal.id} reports the wrong separation`,
      )
      // concretely: never on a block adjacent to the hammer's block
      const hx = Math.abs(portal.chunk.cx - objectives.hammer.chunk.cx)
      const hz = Math.abs(portal.chunk.cz - objectives.hammer.chunk.cz)
      const dx = Math.min(hx, hood.GRID - hx)
      const dz = Math.min(hz, hood.GRID - hz)
      assert.ok(Math.hypot(dx, dz) >= hood.MIN_ANCHOR_SEPARATION, `seed ${seed}: ${portal.id} sits next to the hammer`)
    }
  }
})

test('the exit is the maximum-distance block, and that block is unique', () => {
  const eligible = hood.objectiveCandidates().flat()
  const furthest = Math.max(...eligible.map((block) => block.distance))
  const atFurthest = eligible.filter((block) => block.distance === furthest)
  // Unique for GRID = 7: the antipodal block. So the exit is a fixed point of the
  // run for the same reason the hammer is, and the §10.3 headlights beacon is a
  // place you can learn rather than re-roll every run.
  assert.equal(atFurthest.length, 1, 'the furthest block is no longer unique — tie-breaking now matters')
  for (let seed = 1; seed <= 64; seed++) {
    const exit = hood.placeObjectives(seed, 1).exit
    assert.equal(exit.chunk.cx, atFurthest[0].cx)
    assert.equal(exit.chunk.cz, atFurthest[0].cz)
    assert.equal(exit.distance, furthest)
    assert.equal(exit.kind, 'exit')
  }
})


test('the hammer anchor signature is byte-identical across loops 1..8', () => {
  // §7.1: the hammer is a fixed point of the RUN, not a fixture. This is the
  // assertion that makes dying unable to erase the goal.
  for (const seed of [1, 7, 42, 1337, 90210]) {
    const reference = hood.placeObjectives(seed, 1)
    for (let loop = 2; loop <= 8; loop++) {
      const objectives = hood.placeObjectives(seed, loop)
      assert.equal(objectives.hammer.signature, reference.hammer.signature, `seed ${seed}: the hammer moved on loop ${loop}`)
      assert.equal(objectives.hammer.chunk.cx, reference.hammer.chunk.cx)
      assert.equal(objectives.hammer.chunk.cz, reference.hammer.chunk.cz)
      assert.equal(objectives.hammer.lot.side, reference.hammer.lot.side)
      // and the whole set is loop-invariant, not just the hammer
      assert.equal(objectives.signature, reference.signature, `seed ${seed}: the objective set changed on loop ${loop}`)
    }
  }
})

test('all five anchors are reachable from spawn', () => {
  for (let seed = 1; seed <= 64; seed++) {
    for (const anchor of hood.placeObjectives(seed, 1).all) {
      assert.ok(
        hood.blockDistanceFromSpawn(anchor.chunk.cx, anchor.chunk.cz) >= 0,
        `seed ${seed}: ${anchor.id} is unreachable from spawn`,
      )
      // and its own block's corners can actually walk to the spawn corner
      for (const corner of hood.blockCorners(anchor.chunk.cx, anchor.chunk.cz)) {
        const steps = hood.streetPathLength(corner, hood.SPAWN.node)
        assert.ok(steps >= 0, `seed ${seed}: corner ${corner} of ${anchor.id} cannot reach spawn`)
        assert.ok(steps <= 6, `seed ${seed}: ${anchor.id} is ${steps} steps out, past the torus diameter`)
      }
    }
  }
  assert.equal(hood.blockDistance({ cx: 0, cz: 0 }, { cx: 0, cz: 0 }), 0)
  assert.ok(hood.blockDistance({ cx: 0, cz: 0 }, { cx: 3, cz: 3 }) >= 0)
})

test('placement is deterministic per seed and varies between seeds', () => {
  assert.equal(hood.placeObjectives(1337, 1).signature, hood.placeObjectives(1337, 1).signature)
  const signatures = new Set()
  for (let seed = 1; seed <= 64; seed++) signatures.add(hood.placeObjectives(seed, 1).signature)
  assert.equal(signatures.size, 64, 'two seeds produced the same objective layout')
  // the exit being fixed must not drag the rest of the set down with it
  const exits = new Set()
  for (let seed = 1; seed <= 64; seed++) exits.add(hood.placeObjectives(seed, 1).exit.chunk.cx)
  assert.equal(exits.size, 1, 'the exit block should be the fixed antipodal one')
  // a starved pool is a design bug; placeObjectives throws rather than degrade, so
  // a wide seed sweep is the check that the starvation guard never actually fires
  for (let seed = 1; seed <= 300; seed++) {
    assert.equal(hood.placeObjectives(seed, 1).all.length, 5, `seed ${seed} produced the wrong number of objectives`)
  }
})

// ---------------------------------------------------------------------------
// v2 slice 04 — fixtures and the four rules
// ---------------------------------------------------------------------------

section('Fixture pass (v2 slice 04)')

/** 1 m occupancy grid over one block, with structural fixtures solid. */
function blockWalkability(pass, cx, cz) {
  const step = 1
  const centre = hood.blockCentre(cx, cz)
  const n = Math.round(hood.BLOCK / step)
  const originX = centre.x - hood.BLOCK / 2
  const originZ = centre.z - hood.BLOCK / 2
  const solid = new Uint8Array(n * n)
  for (const fixture of pass.fixtures) {
    if (!fixture.collides) continue
    if (fixture.chunk.cx !== cx || fixture.chunk.cz !== cz) continue
    const i0 = Math.max(0, Math.floor((fixture.x - fixture.w / 2 - originX) / step))
    const i1 = Math.min(n - 1, Math.ceil((fixture.x + fixture.w / 2 - originX) / step))
    const j0 = Math.max(0, Math.floor((fixture.z - fixture.d / 2 - originZ) / step))
    const j1 = Math.min(n - 1, Math.ceil((fixture.z + fixture.d / 2 - originZ) / step))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) solid[j * n + i] = 1
    }
  }
  return { n, step, originX, originZ, solid }
}

function cellOf(grid, x, z) {
  return [
    Math.min(grid.n - 1, Math.max(0, Math.floor((x - grid.originX) / grid.step))),
    Math.min(grid.n - 1, Math.max(0, Math.floor((z - grid.originZ) / grid.step))),
  ]
}

/** The outermost cell on the lot's own street frontage — arriving from the road. */
function streetEdgeCell(grid, lot) {
  const c = cellOf(grid, lot.x, lot.z)
  if (lot.side === 'N') return [c[0], 0]
  if (lot.side === 'S') return [c[0], grid.n - 1]
  if (lot.side === 'W') return [0, c[1]]
  return [grid.n - 1, c[1]]
}

/** 4-connected BFS over free cells. */
function walkReaches(grid, from, to) {
  const { n, solid } = grid
  const start = from[1] * n + from[0]
  const goal = to[1] * n + to[0]
  if (solid[start] || solid[goal]) return false
  const seen = new Uint8Array(n * n)
  const queue = [start]
  seen[start] = 1
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur === goal) return true
    const i = cur % n
    const j = (cur - i) / n
    if (i + 1 < n) push(i + 1, j)
    if (i > 0) push(i - 1, j)
    if (j + 1 < n) push(i, j + 1)
    if (j > 0) push(i, j - 1)
  }
  return false

  function push(i, j) {
    const next = j * n + i
    if (seen[next] || solid[next]) return
    seen[next] = 1
    queue.push(next)
  }
}

/** Closest approach of a world point to any road centreline, in metres. */
function roadClearance(x, z) {
  return (
    Math.min(Math.abs(x / hood.BLOCK - Math.round(x / hood.BLOCK)), Math.abs(z / hood.BLOCK - Math.round(z / hood.BLOCK))) *
    hood.BLOCK
  )
}

test('the fixture constants and slot geometry are self-consistent', () => {
  assert.equal(hood.FIXTURE_DENSITY, 0.75)
  assert.equal(hood.SPAWN_CLEARANCE_BLOCKS, 1)
  assert.equal(hood.APPROACH_SLOT, 1)
  // the lot-width limit is derived, so changing BLOCK or SETBACK cannot break it
  assert.equal(hood.LOT_WIDTH, hood.BLOCK - 2 * hood.SETBACK - 2 * hood.LOT_DEPTH)
  // adjacent loops must get unrelated salts, or the world barely changes
  const salts = [1, 2, 3, 4, 5, 6, 7, 8].map((loop) => hood.loopSalt(loop))
  assert.equal(new Set(salts).size, 8, 'two loops share a salt')
  assert.equal(new Set([1, 2].map((loop) => hood.loopSalt(loop))).size, 2)

  const chunk = hood.chunkAt(1337, 0, 0)
  for (const lot of chunk.lots) {
    const slots = hood.lotSlots(lot)
    assert.equal(slots.length, 3)
    assert.equal(slots[hood.APPROACH_SLOT].x, lot.x, 'the approach slot is the lot centre')
    assert.equal(slots[hood.APPROACH_SLOT].z, lot.z)
    // slot spacing must clear the widest fixture, or two hedges collide
    const spacing = Math.abs(slots[2].x - slots[0].x) || Math.abs(slots[2].z - slots[0].z)
    const widest = Math.max(...hood.STRUCTURAL_KINDS.map((spec) => Math.max(spec.w, spec.d)))
    assert.ok(spacing > widest, `slot spacing ${spacing.toFixed(2)}m does not clear a ${widest}m fixture`)
    // and the approach corridor really contains the middle slot
    const approach = hood.lotApproach(lot)
    assert.ok(hood.rectsOverlap({ x0: slots[1].x - 0.1, x1: slots[1].x + 0.1, z0: slots[1].z - 0.1, z1: slots[1].z + 0.1 }, approach))
  }
})

test('the pass is deterministic per (seed, loop, chunk)', () => {
  assert.equal(hood.fixturePass(1337, 3).signature, hood.fixturePass(1337, 3).signature)
  const first = hood.fixturePass(42, 2)
  // regenerate every chunk in reverse, interleaved with other seeds and loops
  const second = []
  for (let cx = hood.GRID - 1; cx >= 0; cx--) {
    for (let cz = hood.GRID - 1; cz >= 0; cz--) {
      hood.fixturePass(999, 1)
      hood.fixturePass(42, 7)
      second.push(...hood.chunkFixtures(42, 2, cx, cz, first.reserved))
    }
  }
  // compared in a canonical order, because the rebuild visits chunks backwards
  // and the two lists are otherwise the same fixtures in a different order
  const byId = (list) => list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rebuilt = byId(second)
  assert.equal(rebuilt.length, first.fixtures.length, 'the rebuilt pass has a different fixture count')
  assert.equal(rebuilt[0].id, byId(first.fixtures)[0].id)
  assert.equal(
    rebuilt.map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`).join('|'),
    byId(first.fixtures).map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`).join('|'),
    'regenerating a chunk in a different order changed its fixtures',
  )
  assert.equal(hood.fixturePass(42, 2).signature, first.signature)
})


test('rule 1: no fixture ever occupies a street cell', () => {
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    assert.ok(pass.fixtures.length > 200, `loop ${loop} dressed only ${pass.fixtures.length} fixtures`)
    for (const fixture of pass.fixtures) {
      const centre = hood.blockCentre(fixture.chunk.cx, fixture.chunk.cz)
      // strictly inside its own block...
      assert.ok(
        Math.abs(fixture.x - centre.x) + fixture.w / 2 <= hood.BLOCK / 2 + 1e-9,
        `loop ${loop}: ${fixture.id} pokes out of its block on x`,
      )
      assert.ok(
        Math.abs(fixture.z - centre.z) + fixture.d / 2 <= hood.BLOCK / 2 + 1e-9,
        `loop ${loop}: ${fixture.id} pokes out of its block on z`,
      )
      // ...and clear of the carriageway on every side it touches
      assert.ok(
        roadClearance(fixture.x, fixture.z) - Math.max(fixture.w, fixture.d) / 2 >= hood.STREET_HALF_WIDTH,
        `loop ${loop}: ${fixture.id} stands in the road`,
      )
    }
  }
})

test('rule 2: reserved anchors and the spawn clearance stay clear', () => {
  const pass = hood.fixturePass(1337, 1)
  // 9 clearance blocks x 4 lots, plus one lot per objective, none overlapping
  assert.equal(pass.reserved.size, 41)
  let clearanceBlocks = 0
  for (let cx = 0; cx < hood.GRID; cx++) {
    for (let cz = 0; cz < hood.GRID; cz++) if (hood.inSpawnClearance(cx, cz)) clearanceBlocks++
  }
  assert.equal(clearanceBlocks, 9, 'the spawn clearance is the wrong size')

  for (let loop = 1; loop <= 8; loop++) {
    const current = hood.fixturePass(1337, loop)
    // the spawn block itself is always protected (rule 4: never spawn on you)
    assert.ok(current.reserved.has('0,0,N'))
    for (const fixture of current.fixtures) {
      const key = `${fixture.chunk.cx},${fixture.chunk.cz},${fixture.lot}`
      assert.ok(!current.reserved.has(key), `loop ${loop}: fixture ${fixture.id} is on a reserved lot`)
    }
    // and the five objective lots stay reserved in every loop, because anchors do
    // not move (§7.1) while fixtures do
    for (const anchor of current.objectives.all) {
      assert.ok(
        current.reserved.has(`${anchor.chunk.cx},${anchor.chunk.cz},${anchor.lot.side}`),
        `loop ${loop}: ${anchor.id}'s lot is not reserved`,
      )
    }
  }
})

test('rule 3: a walk from the street reaches every anchor, loops 1..8', () => {
  // BFS rather than a rectangle overlap, so a fixture anywhere on the route is
  // caught — not only one sitting on the anchor's own lot
  let checked = 0
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    for (const anchor of pass.objectives.all) {
      const grid = blockWalkability(pass, anchor.chunk.cx, anchor.chunk.cz)
      const lot = hood.chunkAt(1337, anchor.chunk.cx, anchor.chunk.cz).lots.find((l) => l.side === anchor.lot.side)
      const from = streetEdgeCell(grid, lot)
      const to = cellOf(grid, anchor.position.x, anchor.position.z)
      assert.ok(
        walkReaches(grid, from, to),
        `loop ${loop}: ${anchor.id} at ${anchor.chunk.cx},${anchor.chunk.cz} is walled off from the street`,
      )
      checked += 1
    }
  }
  assert.equal(checked, 40, 'five anchors across eight loops')
})


test('the two fixture classes never leak into each other', () => {
  const structural = new Map(hood.STRUCTURAL_KINDS.map((spec) => [spec.kind, spec]))
  const decorative = new Map(hood.DECORATIVE_KINDS.map((spec) => [spec.kind, spec]))
  assert.equal(new Set([...structural.keys(), ...decorative.keys()]).size, 9, 'a kind appears in both classes')
  for (let loop = 1; loop <= 8; loop++) {
    const pass = hood.fixturePass(1337, loop)
    let solid = 0
    let ghost = 0
    for (const fixture of pass.fixtures) {
      if (fixture.cls === 'structural') {
        assert.ok(structural.has(fixture.kind), `${fixture.kind} is not a structural kind`)
        assert.equal(fixture.collides, true, `${fixture.kind} must collide`)
        solid += 1
      } else {
        assert.equal(fixture.cls, 'decorative')
        assert.ok(decorative.has(fixture.kind), `${fixture.kind} is not a decorative kind`)
        assert.equal(fixture.collides, false, `${fixture.kind} must not collide`)
        ghost += 1
      }
      assert.ok(fixture.w > 0 && fixture.d > 0, `${fixture.id} has no footprint`)
      assert.equal(fixture.loop, loop, 'a fixture carries the wrong loop')
    }
    assert.ok(solid > 50, `loop ${loop} had only ${solid} structural fixtures`)
    assert.ok(ghost > 50, `loop ${loop} had only ${ghost} decorative fixtures`)
  }
})

test('the pass changes between loops, including adjacent ones', () => {
  const signatures = []
  for (let loop = 1; loop <= 8; loop++) signatures.push(hood.fixturePass(1337, loop).signature)
  assert.equal(new Set(signatures).size, 8, 'two loops produced the same layout')
  for (let loop = 2; loop <= 8; loop++) {
    assert.notEqual(signatures[loop - 1], signatures[loop - 2], `loops ${loop - 1} and ${loop} are identical`)
  }
  // and they change substantially, not just by one prop. Measured churn between
  // adjacent loops runs about 90%, so 50% is a floor that still means "rebuilt".
  const describe = (pass) => pass.fixtures.map((fixture) => `${fixture.id}:${fixture.cls}:${fixture.kind}`)
  for (const seed of [1, 1337, 90210]) {
    for (let loop = 2; loop <= 8; loop++) {
      const before = new Set(describe(hood.fixturePass(seed, loop - 1)))
      const after = describe(hood.fixturePass(seed, loop))
      const changed = after.filter((entry) => !before.has(entry)).length
      assert.ok(changed / after.length > 0.5, `seed ${seed} loop ${loop}: only ${changed}/${after.length} fixtures changed`)
    }
  }
})

test('fixtures never overlap each other', () => {
  // Regression guard. Slice 02's lots were 46 m wide on a 64 m block, so all four
  // adjacent pairs shared 400 m² and fixtures on neighbouring lots could land
  // inside one another — 21 of 2814 did, across 8 seeds and 8 loops.
  const footprint = (fixture) => ({
    x0: fixture.x - fixture.w / 2,
    x1: fixture.x + fixture.w / 2,
    z0: fixture.z - fixture.d / 2,
    z1: fixture.z + fixture.d / 2,
  })
  let total = 0
  const collisions = []
  for (const seed of [1, 7, 1337]) {
    for (let loop = 1; loop <= 8; loop++) {
      const pass = hood.fixturePass(seed, loop)
      for (let i = 0; i < pass.fixtures.length; i++) {
        for (let j = i + 1; j < pass.fixtures.length; j++) {
          if (hood.rectsOverlap(footprint(pass.fixtures[i]), footprint(pass.fixtures[j]))) {
            collisions.push(`seed ${seed} loop ${loop}: ${pass.fixtures[i].id} overlaps ${pass.fixtures[j].id}`)
          }
        }
      }
      total += pass.fixtures.length
    }
  }
  // collected rather than asserted inline: the message is built per pair, and
  // there are well over a million of them
  assert.deepEqual(collisions.slice(0, 5), [], `${collisions.length} fixtures overlap something else`)
  assert.equal(collisions.length, 0)
  assert.ok(total > 2000, `only ${total} fixtures were overlap-checked`)
})

// ---------------------------------------------------------------------------
// PRNG + determinism (the learnable pattern)
// ---------------------------------------------------------------------------

section('PRNG + deterministic layouts')

test('mulberry32 is reproducible and stays inside [0, 1)', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  for (let i = 0; i < 1000; i++) {
    const value = a()
    assert.equal(value, b())
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

test('different seeds explore different streams', () => {
  const seen = new Set()
  for (let seed = 1; seed <= 16; seed++) {
    const rng = mulberry32(seed)
    seen.add(Array.from({ length: 10 }, () => rng().toFixed(6)).join(','))
  }
  assert.equal(seen.size, 16)
})

test('the maze seed IS the loop number', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.equal(maze.seed, loop)
    assert.equal(maze.loop, loop)
  }
})

test('same loop number => byte-identical maze, even after other loops ran', () => {
  const first = JSON.stringify(generateMaze(3))
  for (const loop of VERIFY_LOOPS) generateMaze(loop)
  assert.equal(JSON.stringify(generateMaze(3)), first)
  assert.equal(JSON.stringify(generateMaze(3)), JSON.stringify(generateMaze(3)))
  assert.equal(mazeSignature(generateMaze(6)), mazeSignature(generateMaze(6)))
})

test('loops 1..8 are all different layouts', () => {
  const signatures = new Set(VERIFY_LOOPS.map((loop) => mazeSignature(generateMaze(loop))))
  assert.equal(signatures.size, VERIFY_LOOPS.length)
})

test('PLAN constants are honoured', () => {
  assert.equal(GRID, 15)
  assert.equal(CELL_SIZE, 3.0)
  assert.equal(WALL_HEIGHT, 2.8)
  assert.equal(WALL_THICKNESS, 0.34)
  assert.equal(LOOP_SECONDS, 60)
  assert.equal(ENTRANCE.r, 0)
  assert.equal(ENTRANCE.c, 0)
  assert.equal(CENTER.r, 7)
  assert.equal(CENTER.c, 7)
})

// ---------------------------------------------------------------------------
// connectivity / solvability
// ---------------------------------------------------------------------------

section('Solvability')

test('every cell is reachable from the entrance', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.equal(reachableCells(maze).size, GRID * GRID, `loop ${loop} is not fully connected`)
  }
})

test('entrance -> centre chamber is always solvable', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.ok(hasPath(maze, maze.entrance, maze.center), `loop ${loop}`)
  }
})

test('entrance -> every shrine is always solvable', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    for (const id of SHRINE_IDS) {
      assert.ok(hasPath(maze, maze.entrance, maze.shrineCells[id]), `loop ${loop} shrine ${id}`)
    }
  }
})

test('the deepest cell of a loop is still walkable inside one loop', () => {
  // MAX_ENTRANCE_DEPTH is the target of the carve rule; the carve budget can be
  // exhausted first, so allow a small documented margin.
  for (let loop = 1; loop <= 60; loop++) {
    const maze = generateMaze(loop)
    const distances = distanceMap(maze, maze.entrance)
    let deepest = 0
    for (const value of distances.values()) deepest = Math.max(deepest, value)
    assert.ok(
      deepest <= MAX_ENTRANCE_DEPTH + 8,
      `loop ${loop} is ${deepest} steps deep (limit ${MAX_ENTRANCE_DEPTH + 8})`,
    )
  }
})

test('shrines and the chamber are reachable within one 60s loop at walk speed', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const toCentre = pathLength(maze, maze.entrance, maze.center)
    const walkSeconds = (toCentre * CELL_SIZE) / WALK_SPEED
    assert.ok(walkSeconds <= LOOP_SECONDS, `loop ${loop}: chamber is a ${walkSeconds.toFixed(1)}s walk`)
    for (const id of SHRINE_IDS) {
      const steps = pathLength(maze, maze.entrance, maze.shrineCells[id])
      const seconds = (steps * CELL_SIZE) / WALK_SPEED
      assert.ok(seconds <= LOOP_SECONDS, `loop ${loop} shrine ${id}: ${seconds.toFixed(1)}s walk`)
    }
  }
})

// ---------------------------------------------------------------------------
// extra carves + the centre chamber
// ---------------------------------------------------------------------------

section('Extra carves + chamber')

test('carve count stays inside the documented budget', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.ok(maze.extraCarved >= MIN_EXTRA_CARVES, `loop ${loop}: ${maze.extraCarved} carves`)
    assert.ok(maze.extraCarved <= EXTRA_CARVE_BUDGET, `loop ${loop}: ${maze.extraCarved} carves`)
  }
})

test('the graph has cycles (multiple routes), not a bare tree', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    // spanning tree + the single chamber doorway + the extra carves
    assert.equal(maze.treePassages, GRID * GRID - 2)
    assert.equal(openEdgeCount(maze), maze.treePassages + 1 + maze.extraCarved)
  }
})

test('the chamber has exactly one doorway, and it is centerApproach', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const approach = DIRS.find((dir) => dir.name === maze.centerApproach)
    assert.ok(approach, `loop ${loop}: unknown approach ${maze.centerApproach}`)
    assert.ok(Object.hasOwn(APPROACH_YAW, maze.centerApproach))
    for (const dir of DIRS) {
      const bit = maze.open[CENTER.r][CENTER.c] & dir.bit
      if (dir.name === maze.centerApproach) assert.ok(bit, `loop ${loop}: doorway is walled`)
      else assert.equal(bit, 0, `loop ${loop}: chamber is open to the ${dir.name}`)
    }
  }
})

test('the entrance corner and the centre never move, shrines keep clear', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    assert.deepEqual(maze.entrance, { r: 0, c: 0 })
    assert.deepEqual(maze.center, { r: 7, c: 7 })
    for (const id of SHRINE_IDS) {
      const cell = maze.shrineCells[id]
      assert.notDeepEqual(cell, ENTRANCE)
      assert.notDeepEqual(cell, CENTER)
      assert.ok(chebyshev(cell, ENTRANCE) >= LANDMARK_CLEARANCE, `${id} too close to the entrance`)
      assert.ok(chebyshev(cell, CENTER) >= LANDMARK_CLEARANCE, `${id} too close to the door`)
    }
  }
})

// ---------------------------------------------------------------------------
// shrines: the stable zone rule
// ---------------------------------------------------------------------------

section('Shrine zones')

test('exactly three shrines, one per documented zone', () => {
  for (let loop = 1; loop <= 60; loop++) {
    const maze = generateMaze(loop)
    assert.deepEqual(Object.keys(maze.shrineCells).sort(), [...SHRINE_IDS].sort())
    for (const zone of ZONES) {
      const cell = maze.shrineCells[zone.id]
      assert.ok(
        cell.r >= zone.minR && cell.r <= zone.maxR && cell.c >= zone.minC && cell.c <= zone.maxC,
        `loop ${loop}: shrine ${zone.id} left zone ${zone.name} (${cell.r},${cell.c})`,
      )
    }
  }
})

test('shrine cells are distinct and never on the doorstep', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const keys = SHRINE_IDS.map((id) => cellKey(maze.shrineCells[id].r, maze.shrineCells[id].c))
    assert.equal(new Set(keys).size, SHRINE_IDS.length, `loop ${loop}: shrines overlap`)
    const distances = distanceMap(maze, maze.entrance)
    for (const id of SHRINE_IDS) {
      const cell = maze.shrineCells[id]
      const steps = distances.get(cellKey(cell.r, cell.c))
      assert.ok(steps !== undefined && steps >= MIN_SHRINE_DISTANCE, `loop ${loop} ${id}: ${steps} steps`)
    }
  }
})

test('shrines are drawn from the closest SHRINE_POOL cells of their zone', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const distances = distanceMap(maze, maze.entrance)
    for (const zone of ZONES) {
      const pool = []
      for (let r = zone.minR; r <= zone.maxR; r++) {
        for (let c = zone.minC; c <= zone.maxC; c++) {
          if (r === CENTER.r && c === CENTER.c) continue
          if (chebyshev({ r, c }, ENTRANCE) < LANDMARK_CLEARANCE) continue
          if (chebyshev({ r, c }, CENTER) < LANDMARK_CLEARANCE) continue
          const d = distances.get(cellKey(r, c))
          if (d === undefined || d < MIN_SHRINE_DISTANCE) continue
          pool.push({ r, c, d })
        }
      }
      pool.sort((a, b) => a.d - b.d)
      const limit = pool[Math.min(SHRINE_POOL, pool.length) - 1].d
      const cell = maze.shrineCells[zone.id]
      const steps = distances.get(cellKey(cell.r, cell.c))
      assert.ok(steps <= limit, `loop ${loop} ${zone.id}: ${steps} steps vs pool limit ${limit}`)
    }
  }
})

// ---------------------------------------------------------------------------
// wall geometry fed to the InstancedMeshes + the collision AABBs
// ---------------------------------------------------------------------------

section('Wall segments')

test('wall segments cover every closed edge exactly once', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const seen = new Map()
    for (const wall of maze.walls) {
      const key = `${wall.r},${wall.c},${wall.edge}`
      assert.ok(!seen.has(key), `loop ${loop}: duplicate wall ${key}`)
      seen.set(key, wall)
    }
    let boundary = 0
    let closedInterior = 0
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const { x, z } = cellToWorld(r, c)
        const expectations = [
          ['N', r === 0, r === 0, { cx: x, cz: z - CELL_SIZE / 2 }],
          ['S', r === GRID - 1 || (maze.open[r][c] & S) === 0, r === GRID - 1, { cx: x, cz: z + CELL_SIZE / 2 }],
          ['W', c === 0, c === 0, { cx: x - CELL_SIZE / 2, cz: z }],
          ['E', c === GRID - 1 || (maze.open[r][c] & E) === 0, c === GRID - 1, { cx: x + CELL_SIZE / 2, cz: z }],
        ]
        for (const [edge, present, isBoundary, position] of expectations) {
          const wall = seen.get(`${r},${c},${edge}`)
          if (present) {
            assert.ok(wall, `loop ${loop}: missing ${edge} wall at ${r},${c}`)
            assert.equal(wall.cx, position.cx)
            assert.equal(wall.cz, position.cz)
            if (isBoundary) boundary += 1
            else closedInterior += 1
          } else {
            assert.equal(wall, undefined, `loop ${loop}: phantom ${edge} wall at ${r},${c}`)
          }
        }
      }
    }
    assert.equal(maze.walls.length, boundary + closedInterior)
    assert.equal(boundary, GRID * 4, 'the maze must be sealed on all four sides')
    // every interior edge is either an open passage or exactly one wall segment
    const interiorEdges = 2 * GRID * (GRID - 1)
    assert.equal(closedInterior, interiorEdges - openEdgeCount(maze))
  }
})

test('wall AABBs use the documented dimensions and stay inside the footprint', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    const limit = (GRID * CELL_SIZE) / 2 + WALL_THICKNESS
    for (const wall of maze.walls) {
      const alongX = wall.axis === 'x'
      assert.equal(wall.hx, alongX ? (CELL_SIZE + WALL_THICKNESS) / 2 : WALL_THICKNESS / 2)
      assert.equal(wall.hz, alongX ? WALL_THICKNESS / 2 : (CELL_SIZE + WALL_THICKNESS) / 2)
      assert.ok(Math.abs(wall.cx) <= limit && Math.abs(wall.cz) <= limit)
    }
  }
})

test('open passages are symmetric between neighbours', () => {
  for (const loop of VERIFY_LOOPS) {
    const maze = generateMaze(loop)
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        for (const dir of DIRS) {
          const nr = r + dir.dr
          const nc = c + dir.dc
          if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue
          const here = (maze.open[r][c] & dir.bit) !== 0
          const there = (maze.open[nr][nc] & dir.opposite) !== 0
          assert.equal(here, there, `loop ${loop}: ${r},${c} ${dir.name} disagrees`)
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// the loop rules: timer, candles, door, bell timeline
// ---------------------------------------------------------------------------

section('Loop rules (the win condition)')

test('the timer counts down and clamps at zero', () => {
  assert.equal(advanceTimer(LOOP_SECONDS, 1.5), LOOP_SECONDS - 1.5)
  assert.equal(advanceTimer(0.4, 1), 0)
  assert.equal(advanceTimer(10, 10), 0)
})

test('candle state is immutable, idempotent and persistent', () => {
  const start = createInitialState(1)
  assert.equal(candlesLit(start.candles), 0)
  const one = applyLightCandle(start, 'A')
  assert.equal(one.candles.A, true)
  assert.equal(start.candles.A, false, 'applyLightCandle must not mutate its input')
  assert.equal(applyLightCandle(one, 'A'), one, 'lighting a lit candle is a no-op')
  assert.equal(candlesLit(applyLightCandle(one, 'B').candles), 2)
})

test('the door opens on the loop AFTER the third candle, and stays open', () => {
  let state = createInitialState(1)
  state = applyLightCandle(state, 'A')
  state = applyLightCandle(state, 'B')
  assert.equal(shouldDoorOpenAtLoopStart(state.candles), false)
  assert.equal(allCandlesLit(state.candles), false)

  state = applyLightCandle(state, 'C')
  assert.equal(allCandlesLit(state.candles), true)
  // lighting the last candle mid-loop does NOT open the door in that loop
  assert.equal(state.doorOpen, false)

  state = beginLoop(state, 2)
  assert.equal(state.loop, 2)
  assert.equal(state.doorOpen, true, 'the door must stand open from loop 2 onward')
  assert.equal(state.timeLeft, LOOP_SECONDS)

  state = beginLoop(state, 3)
  assert.equal(state.doorOpen, true)
  assert.equal(candlesLit(state.candles), 3, 'shrines stay lit across resets')

  state = beginLoop(state, 4)
  assert.equal(state.doorOpen, true)
})

test('phases are the documented four', () => {
  assert.deepEqual(Object.values(PHASE).sort(), ['playing', 'reset', 'start', 'won'].sort())
  assert.equal(createInitialState().phase, PHASE.PLAYING)
  assert.equal(createInitialState(1, PHASE.START).phase, PHASE.START)
  assert.equal(createInitialState(1, PHASE.START).fade, 1, 'the start overlay sits behind black')
  const fresh = restartState(1)
  assert.equal(candlesLit(fresh.candles), 0)
  assert.equal(fresh.doorOpen, false)
  assert.equal(fresh.loop, 1)
})

test('beginLoop can hold the RESET phase (the swap happens behind black)', () => {
  const state = beginLoop(createInitialState(1), 2, PHASE.RESET)
  assert.equal(state.loop, 2)
  assert.equal(state.phase, PHASE.RESET)
})

test('the bell timeline fades to black, swaps, then clears', () => {
  assert.equal(resetFade(0), 0)
  assert.equal(resetFade(RESET_SWAP_AT), 1, 'full black at the moment of the swap')
  assert.ok(resetFade(RESET_SWAP_AT * 0.5) > 0)
  assert.ok(resetFade(RESET_SWAP_AT * 0.5) < 1)
  assert.equal(resetFade(RESET_TIMELINE.total), 0)
  assert.equal(resetFade(RESET_TIMELINE.total + 1), 0)
  assert.equal(resetFade(-1), 0)
  const rising = [...Array(6)].map((_, i) => resetFade((RESET_SWAP_AT * i) / 6))
  for (let i = 1; i < rising.length; i++) assert.ok(rising[i] >= rising[i - 1])
  const falling = [0.1, 0.3, 0.6, 0.9].map((k) => resetFade(RESET_SWAP_AT + RESET_TIMELINE.fadeIn * k))
  for (let i = 1; i < falling.length; i++) assert.ok(falling[i] <= falling[i - 1])
})

test('walls rise with a stagger and are all the way up by the end', () => {
  assert.equal(wallRiseProgress(RESET_SWAP_AT, 0), 0, 'nothing is up at the swap')
  assert.equal(wallRiseProgress(RESET_SWAP_AT - 0.2, 0.3), 0)
  assert.equal(wallRiseProgress(RESET_SWAP_AT + 5, 0.5), 1)
  const mid = wallRiseProgress(RESET_SWAP_AT + 0.5, 0)
  const late = wallRiseProgress(RESET_SWAP_AT + 0.5, 0.4)
  assert.ok(mid > late, 'walls near the entrance rise first')
  assert.equal(wallRiseDelay(0, 40), 0)
  assert.equal(wallRiseDelay(40, 40), 0.5)
  assert.ok(wallRiseDelay(20, 40) > 0 && wallRiseDelay(20, 40) < 0.5)
  assert.equal(wallRiseDelay(10, 0), 0)
})

test('the reset window is long enough for all three tolls', () => {
  assert.ok(RESET_TIMELINE.total > (RESET_TIMELINE.tolls - 1) * RESET_TIMELINE.tollSpacing)
  assert.ok(RESET_SWAP_AT > 0 && RESET_SWAP_AT < RESET_TIMELINE.total)
})

// ---------------------------------------------------------------------------
// the mutable store React subscribes to
// ---------------------------------------------------------------------------

section('Store')

test('the store only notifies when a value actually changes', () => {
  const store = createStore(createInitialState(1, PHASE.PLAYING))
  let notifications = 0
  const unsubscribe = store.subscribe(() => {
    notifications += 1
  })
  store.set({ phase: PHASE.PLAYING })
  assert.equal(notifications, 0, 'setting the same phase must not re-render React')
  store.set({ loop: 2 })
  assert.equal(notifications, 1)
  store.set({ timeLeft: 59.5, loop: 2 })
  assert.equal(notifications, 2)
  assert.equal(store.listenerCount(), 1)
  unsubscribe()
  assert.equal(store.listenerCount(), 0)
  store.set({ loop: 3 })
  assert.equal(notifications, 2, 'unsubscribed listeners must not fire')
  assert.equal(store.get().loop, 3)
})

test('store.update() runs the pure reducers', () => {
  const store = createStore(createInitialState(1))
  store.update((state) => applyLightCandle(state, 'B'))
  assert.equal(store.get().candles.B, true)
  store.update((state) => beginLoop(state, 2))
  assert.equal(store.get().loop, 2)
  assert.equal(store.get().doorOpen, false, 'two candles is not enough')
  store.update((state) => applyLightCandle(state, 'A'))
  store.update((state) => applyLightCandle(state, 'C'))
  store.update((state) => beginLoop(state, 3))
  assert.equal(store.get().doorOpen, true)
})

test('hudSnapshot exposes exactly what the HUD paints', () => {
  const state = createInitialState(4)
  state.timeLeft = LOOP_SECONDS / 2
  state.candles.A = true
  const hud = hudSnapshot(state)
  assert.equal(hud.loop, 4)
  assert.equal(hud.timeFraction, 0.5)
  assert.equal(hud.candlesLit, 1)
  assert.equal(hud.candles.A, true)
  assert.equal(hud.fade, 0)
  assert.equal(hud.prompt, null)
  assert.equal(hudSnapshot(createInitialState(2)).timeFraction, 1)
})

// ---------------------------------------------------------------------------
// end-to-end: a scripted run that wins (headless proof the game is beatable)
// ---------------------------------------------------------------------------

section('Scripted run')

test('one candle per loop, then the door opens and the chamber is a walk away', () => {
  let state = createInitialState(1)

  // loop 1: light shrine A, the bell rings
  state = applyLightCandle(state, 'A')
  assert.equal(state.doorOpen, false)
  state = beginLoop(state, 2)
  assert.equal(state.doorOpen, false, 'one candle is not enough')
  assert.equal(state.loop, 2)
  assert.equal(state.timeLeft, LOOP_SECONDS, 'the timer refills every loop')
  assert.equal(state.candles.A, true, 'the first shrine stays lit')

  // loop 2: shrine B
  state = applyLightCandle(state, 'B')
  state = beginLoop(state, 3)
  assert.equal(state.doorOpen, false, 'two candles are not enough')
  assert.equal(candlesLit(state.candles), 2)

  // loop 3: shrine C — the third and last one
  state = applyLightCandle(state, 'C')
  assert.equal(allCandlesLit(state.candles), true)
  state = beginLoop(state, 4)
  assert.equal(state.loop, 4)
  assert.equal(state.doorOpen, true, 'the door stands open on the loop after the third candle')

  // loop 4: walk to the chamber. Its only doorway is centerApproach, and the
  // closed-door blocking collider is gone, so the centre is reachable.
  const maze = generateMaze(state.loop)
  const steps = pathLength(maze, maze.entrance, maze.center)
  const seconds = (steps * CELL_SIZE) / WALK_SPEED
  assert.ok(steps > 0, 'the chamber must be reachable')
  assert.ok(seconds <= LOOP_SECONDS, `the walk takes ${seconds.toFixed(1)}s`)

  // three of the chamber's four edges are real walls; the fourth is the doorway
  const walled = DIRS.filter((dir) => hasWall(maze, CENTER.r, CENTER.c, dir))
  assert.equal(walled.length, 3, 'exactly three of the chamber edges are walls')
  assert.equal(walled.find((dir) => dir.name === maze.centerApproach), undefined)

  // and the win trigger itself: a pure rule — you must be inside the chamber
  const centre = cellToWorld(CENTER.r, CENTER.c)
  assert.ok(DOOR_WIN_RADIUS < CELL_SIZE / 2, 'the win radius must sit inside the chamber')
  assert.ok(isInsideChamber({ x: centre.x, z: centre.z }, centre))
  assert.ok(!isInsideChamber({ x: centre.x + CELL_SIZE, z: centre.z }, centre))
  assert.ok(!isInsideChamber(null, centre))
})

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

let total = 0
for (const group of sections) {
  console.log(`\n${group.title}`)
  for (const entry of group.tests) {
    total += 1
    console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`)
    if (!entry.ok) console.log(`        ${entry.error}`)
  }
}
console.log(`\n${passed}/${total} checks passed${failed ? ` — ${failed} FAILED` : ' — all green'}`)
if (failed > 0) process.exitCode = 1
