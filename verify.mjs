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
// v2 slice 05. Namespace again: `breath`, `portals` and friends are game-state
// names as well as rule names, and flat imports would read ambiguously.
import * as rules from './src/game/rules.js'
// v2 slice 06. Namespace for the same reason, twice over: `state`, `distance`,
// `sounds` and `captured` are all frame fields *and* all rule names, and the
// creature's states would sit next to v1's PHASE table looking like one thing.
import * as beast from './src/game/creature.js'
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
// v2 slice 05 — portal verb, breath, persistence
// ---------------------------------------------------------------------------

section('Portal verb, breath, persistence (v2 slice 05)')

const DT = 1 / 60

test('the slice 05 constants match the design', () => {
  assert.equal(rules.PORTAL_SHUT_SECONDS, 1.2)
  assert.equal(rules.PORTAL_NOISE_THRESHOLD, 0.5, '§5.2: silent first half, loud second half')
  assert.equal(rules.PORTAL_SOUND_RADIUS, 25, '§6.2: second loudest thing in the game')
  assert.equal(rules.EXIT_WIN_RADIUS, 1.15, 'must match v1 DOOR_WIN_RADIUS')
  assert.ok(rules.BREATH_RECOVERY_THRESHOLD > 0, 'hysteresis needs a threshold above zero')
  assert.ok(rules.BREATH_RECOVERY_THRESHOLD < 1, 'a threshold of 1 would never lift')
  assert.ok(rules.BREATH_DRAIN_PER_SEC > rules.BREATH_RECOVER_PER_SEC, 'recovery must be slower than drain')
})

test('the portal hold is silent below the midpoint and loud above it', () => {
  let progress = 0
  let firstLoud = null
  let frames = 0
  for (; frames < 600 && progress < 1; frames++) {
    const result = rules.portalShutProgress(progress, DT, true)
    // the invariant, asserted every single frame rather than at one sample
    assert.equal(
      result.soundEmitted,
      result.progress >= rules.PORTAL_NOISE_THRESHOLD,
      `frame ${frames}: sound ${result.soundEmitted} at progress ${result.progress}`,
    )
    if (result.soundEmitted && firstLoud === null) firstLoud = result.progress
    progress = result.progress
  }
  assert.equal(progress, 1, 'the hold never completed')
  assert.ok(firstLoud >= rules.PORTAL_NOISE_THRESHOLD, 'the shutdown was audible before the midpoint')
  // and it is genuinely silent for a real stretch of time first
  const quietSeconds = (rules.PORTAL_SHUT_SECONDS * rules.PORTAL_NOISE_THRESHOLD)
  assert.ok(quietSeconds > 0.5, 'the silent half is too short to be a decision')
  // the first half is committed silence, so a creature arriving there is free
  assert.equal(rules.portalShutProgress(0, DT * 10, true).soundEmitted, false)
})

test('the portal hold clamps at exactly 1.0 and completes on one frame only', () => {
  let progress = 0
  let completions = 0
  for (let i = 0; i < 600; i++) {
    const result = rules.portalShutProgress(progress, DT, true)
    if (result.completed) completions += 1
    assert.ok(result.progress <= 1, `progress overshot to ${result.progress}`)
    assert.ok(result.progress >= 0, 'progress went negative')
    progress = result.progress
  }
  assert.equal(progress, 1, 'progress should saturate at exactly 1')
  assert.equal(completions, 1, `a held portal completed ${completions} times`)
  // a single huge timestep must not skip past the threshold silently
  const jump = rules.portalShutProgress(0, 99, true)
  assert.equal(jump.progress, 1)
  assert.equal(jump.completed, true)
  assert.equal(jump.soundEmitted, true)
})

test('releasing the hold decays progress and stops the sound', () => {
  const before = rules.portalShutProgress(0.8, DT, true)
  assert.equal(before.soundEmitted, true, '0.8 should be loud')
  const after = rules.portalShutProgress(before.progress, DT, false)
  assert.ok(after.progress < before.progress, 'releasing must decay progress')
  assert.equal(after.soundEmitted, false, 'releasing must stop the noise immediately')
  assert.equal(after.completed, false)
  // aborting is free: it bleeds to nothing and never completes
  let progress = 0.8
  for (let i = 0; i < 600; i++) {
    const result = rules.portalShutProgress(progress, DT, false)
    assert.equal(result.completed, false, 'an abandoned hold completed a portal')
    progress = result.progress
  }
  assert.equal(progress, 0, 'progress should bleed all the way back to zero')
  // and decay is faster than the fill, so re-committing is responsive
  assert.ok(rules.PORTAL_RELEASE_DECAY > 1, 'decay should outrun the fill')
})


test('breath drains monotonically, recovers, and locks out with hysteresis', () => {
  let breath = 1
  let exhausted = false
  let previous = breath
  for (let i = 0; i < 600 && !exhausted; i++) {
    const result = rules.breathStep(breath, exhausted, true, DT)
    assert.ok(result.breath <= previous, `breath rose while sprinting: ${previous} -> ${result.breath}`)
    previous = result.breath
    breath = result.breath
    exhausted = result.exhausted
  }
  assert.equal(exhausted, true, 'sprinting forever never exhausted the player')
  assert.equal(breath, 0, 'exhaustion should land exactly on zero')

  // the lockout lifts at the threshold, not at zero, and NOT while sprinting.
  // Compared against the POST-step value, since that is what the rule inspects.
  let frames = 0
  while (exhausted && frames < 600) {
    const result = rules.breathStep(breath, exhausted, true, DT) // sprint key still down
    assert.equal(
      result.exhausted,
      result.breath < rules.BREATH_RECOVERY_THRESHOLD,
      `lockout disagrees with the threshold at breath ${result.breath}`,
    )
    breath = result.breath
    exhausted = result.exhausted
    frames += 1
  }
  assert.equal(exhausted, false, 'the lockout never lifted')
  assert.ok(breath >= rules.BREATH_RECOVERY_THRESHOLD, `lockout lifted at breath ${breath}`)

  // recovery: walking refills, and never past full
  let walking = breath
  for (let i = 0; i < 3000; i++) {
    const result = rules.breathStep(walking, false, false, DT)
    assert.ok(result.breath >= walking, 'breath fell while walking')
    assert.ok(result.breath <= 1, `breath overfilled to ${result.breath}`)
    walking = result.breath
  }
  assert.equal(walking, 1, 'breath should refill to full')

  // THE hysteresis case. Bobbing means mashing the sprint key on and off, not
  // resting: while locked out the key must be IGNORED, so the meter can never
  // dip. Without the lockout the flag would flicker every frame and the player
  // would get an infinite sprint out of two alternating inputs.
  // ...and bobbing must not PREVENT recovery either: the lockout still lifts
  // once the threshold is reached, roughly on schedule. Measured from where the
  // meter actually starts, which is just under the threshold, not from zero.
  const BOB_START = 0.34
  let bobBreath = BOB_START
  let bobExhausted = true
  let everDipped = false
  let liftedAt = null
  for (let i = 0; i < 120; i++) {
    const wasExhausted = bobExhausted
    const result = rules.breathStep(bobBreath, bobExhausted, i % 2 === 0, DT)
    // only a step that BEGAN locked out is allowed to prove the point; once the
    // lockout legitimately lifts, sprinting drains again and a dip is correct
    if (wasExhausted && result.breath < bobBreath) everDipped = true
    if (wasExhausted && !result.exhausted && liftedAt === null) liftedAt = i
    bobBreath = result.breath
    bobExhausted = result.exhausted
  }
  assert.equal(everDipped, false, 'bobbing the sprint key drained breath while locked out')
  assert.ok(liftedAt !== null, 'bobbing the sprint key kept the player locked out forever')
  const framesToLift = (rules.BREATH_RECOVERY_THRESHOLD - BOB_START) / rules.BREATH_RECOVER_PER_SEC / DT
  assert.ok(
    Math.abs(liftedAt - framesToLift) < 2,
    `lockout lifted at frame ${liftedAt}, expected about ${Math.round(framesToLift)}`,
  )

  // and the lockout has a floor: it lasts exactly as long as it takes to reach
  // the threshold, not one frame
  let lockBreath = 0
  let lockExhausted = true
  let elapsed = 0
  while (lockExhausted && elapsed < 100) {
    const result = rules.breathStep(lockBreath, lockExhausted, true, DT)
    lockBreath = result.breath
    lockExhausted = result.exhausted
    elapsed += DT
  }
  const expected = rules.BREATH_RECOVERY_THRESHOLD / rules.BREATH_RECOVER_PER_SEC
  assert.ok(
    Math.abs(elapsed - expected) < DT * 2,
    `lockout lasted ${elapsed.toFixed(3)}s, expected about ${expected.toFixed(3)}s`,
  )
})

test('exhaustion makes you louder', () => {
  // §7.3: the rule is not "sprinting costs stamina", it is that being out of
  // breath raises your sound radius
  assert.equal(rules.breathSoundRadius(9, false), 9, 'walking is 9 m (§6.2)')
  assert.equal(rules.breathSoundRadius(22, false), 22, 'sprinting is 22 m (§6.2)')
  assert.equal(rules.breathSoundRadius(9, true), 9 + rules.EXHAUSTED_BREATH_SOUND_BONUS)
  assert.equal(rules.EXHAUSTED_BREATH_SOUND_BONUS, 6)
  // Exhausted sprinting is 28 m: louder than a portal shutdown (25) and louder
  // than walking (9), but the hammer toll is still 30 and still the loudest
  // thing in the game. That ordering is the point - being spent is a liability,
  // but the hammer stays the player's own weapon.
  assert.equal(rules.breathSoundRadius(22, true), 28)
  assert.ok(rules.breathSoundRadius(22, true) > rules.PORTAL_SOUND_RADIUS, 'exhaustion should out-shout a portal')
  assert.ok(rules.breathSoundRadius(22, true) < 30, 'exhaustion must not out-shout the hammer toll (§6.2)')
  assert.ok(rules.breathSoundRadius(9, true) > rules.breathSoundRadius(9, false))
})


test('every row of the capture table behaves as §9.1 says', () => {
  assert.equal(rules.CAPTURE_TABLE.length, 10)
  const keep = rules.CAPTURE_TABLE.filter((row) => row.mutation === 'keep').map((row) => row.field)
  assert.deepEqual(keep, ['portals', 'hammerHeld', 'banishCount', 'finale', 'dusk'])

  // a state where every field is deliberately at a non-default value
  const dirty = {
    portals: { A: true, B: true, C: false },
    hammerHeld: true,
    banishCount: 3,
    finale: true,
    dusk: 0.66,
    loop: 5,
    player: { x: 500, z: 500 },
    prompt: 'shutdown',
    creature: { state: 'chase', reemergenceCount: 4, awareness: 0.8 },
    sounds: [{ radius: 9 }],
  }
  for (const row of rules.CAPTURE_TABLE) {
    assert.ok(row.field in dirty, `the table mentions ${row.field}, which the test does not dirty`)
  }

  const before = { ...rules.createInitialState(hood.placeObjectives(1337, 1)), ...dirty }
  const after = rules.applyCapture(before)

  for (const row of rules.CAPTURE_TABLE) {
    const from = rules.readField(before, row.field)
    const to = rules.readField(after, row.field)
    if (row.mutation === 'keep') {
      assert.equal(JSON.stringify(to), JSON.stringify(from), `${row.field} should survive a capture`)
    } else if (row.mutation === 'increment') {
      assert.equal(to, from + 1, `${row.field} should increment by one`)
    } else {
      assert.notEqual(JSON.stringify(to), JSON.stringify(from), `${row.field} should reset on capture`)
    }
  }
  // the two named consequences, spelled out because they are the whole point
  assert.equal(after.player.x, hood.SPAWN.position.x, 'the player must be returned to spawn')
  assert.equal(after.player.z, hood.SPAWN.position.z)
  assert.equal(after.creature.state, 'stalk', 'a player holding the hammer returns to STALK')
  assert.equal(after.creature.reemergenceCount, 0, 'the aggression ladder restarts')
  // and the table is frozen, so a caller cannot quietly rewrite the rules
  assert.equal(Object.isFrozen(rules.CAPTURE_TABLE), true)
})

test('a shut portal ignores the verb and stays shut across a capture', () => {
  let state = rules.createInitialState(hood.placeObjectives(1337, 1))
  for (let i = 0; i < 200 && !state.portals.A; i++) state = rules.applyPortalHold(state, 'A', DT, true)
  assert.equal(state.portals.A, true, 'holding never shut portal A')

  // holding it again changes nothing at all — no double completion, no progress
  const held = rules.applyPortalHold(state, 'A', DT, true)
  assert.equal(held, state, 'a dead portal was not inert')
  assert.ok(held.progress.A > 0, 'a shut portal lost its progress')
  assert.deepEqual(rules.portalShutProgress(0.4, DT, true, true), {
    progress: 1,
    soundEmitted: false,
    completed: false,
  })
  assert.equal(rules.applyPortalHold(state, 'Z', DT, true), state, 'an unknown portal id was invented')

  // permanence: A survives any number of captures (§5.3). This run started fresh,
  // so loop 1 plus five captures is loop 6 and only portal A is shut.
  for (let i = 0; i < 5; i++) state = rules.applyCapture(state)
  assert.equal(state.portals.A, true, 'a shut portal was undone by dying')
  assert.equal(state.portals.B, false, 'an untouched portal was shut for free')
  assert.equal(state.loop, 6, 'five captures from loop 1 is loop 6')
  assert.equal(state.dusk, 1 / 3, 'dusk followed the progress, not the deaths')
  assert.equal(state.hammerHeld, false, 'the hammer was never picked up in this run')
  assert.equal(state.banishCount, 0, 'nothing was banished in this run')
  assert.equal(state.finale, false, 'the finale is not open after one portal')
})

test('the third portal opens the finale, and only the third', () => {
  let state = rules.createInitialState(hood.placeObjectives(42, 1))
  for (const id of ['A', 'B']) {
    for (let i = 0; i < 200 && !state.portals[id]; i++) state = rules.applyPortalHold(state, id, DT, true)
    assert.equal(state.portals[id], true, `portal ${id} did not shut`)
    assert.equal(state.finale, false, `the finale opened on portal ${id}`)
    assert.equal(state.dusk, rules.portalsShut(state.portals) / 3)
  }
  for (let i = 0; i < 200 && !state.portals.C; i++) state = rules.applyPortalHold(state, 'C', DT, true)
  assert.equal(state.finale, true, 'the third portal did not open the finale')
  assert.equal(state.dusk, 1, 'dusk should be full with every portal shut')
  assert.equal(rules.portalsShut(state.portals), 3)
  assert.equal(rules.duskForPortals({ A: true, B: true, C: true }), 1)
  assert.equal(rules.duskForPortals({ A: false, B: false, C: false }), 0)
  // dusk is a function of progress alone, so it can never be a death spiral
  assert.equal(rules.applyCapture(state).dusk, 1, 'dusk fell when the player died')
})

test('isInsideExit mirrors v1 isInsideChamber, negatives included', () => {
  assert.equal(rules.EXIT_WIN_RADIUS, DOOR_WIN_RADIUS)
  const cases = [
    [{ x: 0, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 1.1, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 1.2, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: -1.15, z: 0 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0, z: -1.15 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0.8, z: 0.8 }, { x: 0, z: 0 }, 1.15],
    [{ x: 0.81, z: 0.81 }, { x: 0, z: 0 }, 1.15],
    [{ x: 900, z: -900 }, { x: 0, z: 0 }, 1.15],
    [null, { x: 0, z: 0 }, 1.15],
    [{ x: 0, z: 0 }, null, 1.15],
    [{ x: 0, z: 0 }, undefined, 1.15],
    [null, null, 1.15],
    [{ x: 3, z: 4 }, { x: 3, z: 4 }, 5],
    [{ x: 8, z: 4 }, { x: 3, z: 4 }, 5],
  ]
  for (const [position, centre, radius] of cases) {
    assert.equal(
      rules.isInsideExit(position, centre, radius),
      isInsideChamber(position, centre, radius),
      `isInsideExit disagreed with isInsideChamber at ${JSON.stringify(position)}`,
    )
  }
  assert.equal(
    rules.isInsideExit({ x: 0, z: 0 }, { x: 0, z: 0 }),
    isInsideChamber({ x: 0, z: 0 }, { x: 0, z: 0 }),
  )
  assert.equal(rules.isInsideExit({ x: 2, z: 0 }, { x: 0, z: 0 }), false)
  assert.equal(rules.isInsideExit(null, { x: 0, z: 0 }), false)
})

test('winning needs the finale as well as the geometry', () => {
  const objectives = hood.placeObjectives(1337, 1)
  let state = rules.createInitialState(objectives)
  const exit = objectives.exit.position
  const inside = { x: exit.x, z: exit.z }
  // standing in the exit before the third portal does nothing
  assert.equal(rules.isInsideExit(inside, exit), true, 'the geometry should already be satisfied')
  assert.equal(rules.checkExitWin(state, inside), false, 'won without triggering the finale')
  for (const id of ['A', 'B', 'C']) {
    for (let i = 0; i < 200 && !state.portals[id]; i++) state = rules.applyPortalHold(state, id, DT, true)
  }
  assert.equal(state.finale, true)
  assert.equal(rules.checkExitWin(state, inside), true, 'standing in the exit did not win')
  assert.equal(rules.checkExitWin(state, { x: exit.x + 50, z: exit.z }), false, 'won from across the map')
  // the finale is a flag, not a new PHASE: the state still reads as playing
  assert.equal(typeof state.finale, 'boolean')
})

// ---------------------------------------------------------------------------
// v2 slice 06 — the creature's awareness, sound table and sight
// ---------------------------------------------------------------------------

section('Creature awareness (v2 slice 06)')

test('the slice 06 constants match the design', () => {
  assert.equal(beast.AWARENESS_INVESTIGATE, 0.4, '§6.2: 0.4 is the investigate threshold')
  assert.equal(beast.AWARENESS_CHASE, 1.0, '§6.2: 1.0 is the chase threshold')
  assert.ok(beast.SOUND_TO_SIGHT_RATIO >= 4 && beast.SOUND_TO_SIGHT_RATIO <= 5, '§6.2: four to five times')
  assert.equal(
    beast.SOUND_FILL_PER_SEC,
    beast.SOUND_TO_SIGHT_RATIO * beast.SIGHT_FILL_PER_SEC,
    'the sound rate must be derived from the ratio, not typed beside it',
  )
  assert.ok(beast.SOUND_FILL_PER_SEC > beast.SIGHT_FILL_PER_SEC)
  assert.equal(beast.STAGGER_SECONDS, 1.6, 'the pass-8 stun length')
  assert.ok(beast.BANISH_RANGE > beast.CAPTURE_RADIUS, 'a banish has to reach past contact')
  assert.deepEqual([...beast.AWARENESS_LEVELS], ['unaware', 'investigate', 'chase'])
  for (const state of ['dormant', 'telegraph', 'stalk', 'reposition', 'chase', 'stagger', 'enraged']) {
    assert.ok(beast.CREATURE_STATES.includes(state), `${state} is not a state`)
  }
  assert.equal(beast.createCreature().state, 'telegraph', 'Act I opens in TELEGRAPH (§6.1)')
})

test('the sound table is the §6.2 table and nothing else', () => {
  assert.deepEqual({ ...beast.SOUND_RADII }, { walk: 9, sprint: 22, portal: 25, toll: 30 })
  assert.equal(beast.SOUND_RADII.portal, rules.PORTAL_SOUND_RADIUS, 'one definition of the shutdown radius (§5.2, §6.2)')
  // the documented ordering, which is the whole point of the table
  assert.ok(beast.SOUND_RADII.toll > beast.SOUND_RADII.portal, 'the hammer outranks the shutdown')
  assert.ok(beast.SOUND_RADII.portal > beast.SOUND_RADII.sprint, 'a shutdown outranks a sprint')
  assert.ok(beast.SOUND_RADII.sprint > beast.SOUND_RADII.walk, 'a sprint outranks a walk')
  for (const kind of Object.keys(beast.SOUND_RADII)) {
    assert.equal(beast.soundRadius(kind), beast.SOUND_RADII[kind], `${kind} radius`)
  }
  assert.equal(beast.soundRadius('nonsense'), 0, 'an unknown event is silent, not a crash')
})

test('the hammer stays the loudest thing in the game whatever the player is doing', () => {
  const exhaustedSprint = beast.soundRadius('sprint', { exhausted: true })
  assert.ok(
    exhaustedSprint <= beast.SOUND_RADII.toll,
    `an exhausted sprint (${exhaustedSprint} m) is louder than the hammer`,
  )
  // §7.3's bonus does lift a sprint past the shutdown, and that is intended
  assert.ok(exhaustedSprint > beast.SOUND_RADII.portal, 'exhaustion should out-shout a shutdown')
  // the gate that matters is directional: sprinting must be louder than walking,
  // at every distance, because §6.2 lives or dies on the player running away
  for (const distance of [0, 4, 8, 12, 16, 20, 22]) {
    const sprint = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance }] }).heard[0]
    const walk = beast.awarenessStep(0, DT, { sounds: [{ kind: 'walk', distance }] }).heard[0]
    if (!sprint) {
      assert.equal(walk, undefined, `a walk is heard at ${distance} m but a sprint is not`)
      continue
    }
    // at the source the two doses are equal — what differs is how far out the
    // sprint carries and how often it happens, which the next two lines cover
    assert.ok(sprint.step >= (walk ? walk.step : 0), `${distance} m: a sprint cannot be quieter than a walk`)
    if (walk && distance > 0) {
      assert.ok(sprint.step > walk.step, `${distance} m: a sprint must be louder than a walk`)
    }
  }
  // beyond the walk's radius the sprint is the only thing the creature hears
  assert.equal(beast.awarenessStep(0, DT, { sounds: [{ kind: 'walk', distance: 15 }] }).heard.length, 0)
  assert.equal(beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 15 }] }).heard.length, 1)
  // and per second, not per event, a sprint is louder everywhere they are both heard
  const stridesPerSecond = (speed) => speed / 1.7 // the player's 1.7 m stride, player.js
  for (const distance of [0, 2, 5, 8]) {
    const rate = (kind, speed) => {
      const step = beast.awarenessStep(0, DT, { sounds: [{ kind, distance }] }).heard[0]
      return step ? (step.step * stridesPerSecond(speed)) / beast.SOUND_EVENT_SECONDS : 0
    }
    assert.ok(rate('sprint', 6.0) > rate('walk', 3.6), `${distance} m: sprinting must fill the meter faster`)
  }
})

test('standing still is silence, and exhaustion is the only way to break it', () => {
  assert.equal(beast.soundRadius('still'), 0, '§6.2: a still player emits nothing')
  assert.equal(
    beast.soundRadius('still', { exhausted: true }),
    rules.EXHAUSTED_BREATH_SOUND_BONUS,
    '§7.3: exhaustion makes you louder even standing still',
  )
  // +6 on top of the gait radius, through the one function that owns the bonus
  for (const kind of ['walk', 'sprint']) {
    assert.equal(
      beast.soundRadius(kind, { exhausted: true }) - beast.soundRadius(kind, { exhausted: false }),
      rules.EXHAUSTED_BREATH_SOUND_BONUS,
      `${kind}: the §7.3 bonus`,
    )
    assert.equal(beast.soundRadius(kind, { exhausted: true }), rules.breathSoundRadius(beast.SOUND_RADII[kind], true))
  }
  // and the strategic consequence: a still player at full breath is not a stimulus
  const quiet = beast.awarenessStep(0.5, DT, { sounds: [{ kind: 'still', distance: 0 }] })
  assert.equal(quiet.heard.length, 0)
  assert.ok(quiet.decayed > 0, 'standing still must let the meter fall')
  const gasping = beast.awarenessStep(0.5, DT, { sounds: [{ kind: 'still', distance: 0, exhausted: true }] })
  assert.equal(gasping.heard.length, 1, 'gasping while still is still a stimulus')
  assert.ok(gasping.awareness > 0.5)
})

test('sound fills the meter four to five times faster than sight, at every strength', () => {
  const gain = (frame) => beast.awarenessStep(0, DT, frame).awareness
  // one full-strength sound window against one second of full-strength sight
  const sound = gain({ sounds: [{ kind: 'sprint', distance: 0 }] }) / beast.SOUND_EVENT_SECONDS
  const sight = gain({ seen: true, sightDistance: 0, sightRange: 14 }) / DT
  const ratio = sound / sight
  assert.ok(Math.abs(ratio - beast.SOUND_TO_SIGHT_RATIO) < 1e-9, `measured ratio ${ratio}`)
  assert.ok(ratio >= 4 && ratio <= 5, '§6.2: roughly four to five times')
  // the ratio is a property of the integration, not of one lucky sample
  for (const soundDistance of [0, 5, 11, 20]) {
    for (const sightDistance of [0, 3.5, 7, 13]) {
      const heard = gain({ sounds: [{ kind: 'walk', distance: soundDistance }] })
      const glanced = gain({ seen: true, sightDistance, sightRange: 14 })
      if (!(heard > 0) || !(glanced > 0)) continue
      const expected =
        (beast.SOUND_FILL_PER_SEC * beast.SOUND_EVENT_SECONDS * beast.soundStrength(soundDistance, 9)) /
        (beast.SIGHT_FILL_PER_SEC * beast.sightStrength(sightDistance, 14) * DT)
      assert.ok(
        Math.abs(heard / glanced - expected) < 1e-9,
        `sound ${soundDistance} m vs sight ${sightDistance} m: measured ${heard / glanced}, expected ${expected}`,
      )
    }
  }
})

test('sight confirms and holds the meter; sound is what acquires it', () => {
  // sight never decays: this is the entire tactical value of breaking contact
  const held = beast.awarenessStep(0.9, 1, { seen: true, sightDistance: 12, sightRange: 14 })
  assert.equal(held.decayed, 0, 'sight must not bleed the meter')
  assert.ok(held.awareness > 0.9)
  let a = 0.62
  for (let i = 0; i < 120; i += 1) {
    a = beast.awarenessStep(a, DT, { seen: true, sightDistance: 3, sightRange: 14 }).awareness
  }
  assert.ok(a > 0.62, 'sight does fill, which is why it is worth hiding')
  // ...but it takes seconds of unbroken attention, while a sprint is heard in one
  const secondsOfSightToChase = 1 / beast.SIGHT_FILL_PER_SEC
  assert.ok(secondsOfSightToChase > 8, `point-blank sight chases in ${secondsOfSightToChase.toFixed(1)} s`)
  const strides = Math.ceil(1 / (beast.SOUND_FILL_PER_SEC * beast.SOUND_EVENT_SECONDS * beast.soundStrength(5, 22)))
  const secondsOfSprintToChase = strides * 0.3 // a 1.7 m stride at 6.0 m/s is 0.28 s
  assert.ok(secondsOfSprintToChase < secondsOfSightToChase / 2, 'sound must be the fast lane')
  // breaking the sightline ends the hold on the very next frame
  const broken = beast.awarenessStep(0.9, DT, { seen: false })
  assert.ok(broken.decayed > 0, 'losing sight resumes the decay immediately')
  assert.ok(broken.awareness < 0.9)
  // and `immune` (§8.1) is the extreme case: Act I is not silent, it is deaf
  const deaf = beast.awarenessStep(0.9, 1, {
    immune: true,
    seen: true,
    sightDistance: 0,
    sounds: [{ kind: 'sprint', distance: 0 }],
  })
  assert.equal(deaf.awareness, 0, 'an immune frame does not even decay')
  assert.equal(deaf.heard.length, 0)
  assert.equal(deaf.seen, false)
})

test('the meter decays only on a frame with no stimulus at all', () => {
  const silent = beast.awarenessStep(0.8, DT, {})
  assert.ok(Math.abs(silent.decayed - beast.AWARENESS_DECAY_PER_SEC * DT) < 1e-12)
  assert.ok(Math.abs(silent.awareness - (0.8 - beast.AWARENESS_DECAY_PER_SEC * DT)) < 1e-12)
  // a sound that did not reach the creature is not a stimulus
  assert.ok(beast.awarenessStep(0.8, DT, { sounds: [{ kind: 'walk', distance: 40 }] }).decayed > 0)
  // one that did, is
  assert.equal(beast.awarenessStep(0.8, DT, { sounds: [{ kind: 'sprint', distance: 5 }] }).decayed, 0)
  assert.equal(beast.awarenessStep(0.8, DT, { seen: true, sightDistance: 5 }).decayed, 0)
  // the decay floors at zero rather than going negative
  assert.equal(beast.awarenessStep(0.0005, DT, {}).awareness, 0)
  // and silence is a real escape: under 12 s of it a full chase is gone
  assert.ok(1 / beast.AWARENESS_DECAY_PER_SEC < 12, 'silence must be able to lose a chase')
  assert.ok(0.6 / beast.AWARENESS_DECAY_PER_SEC < 6, 'silence must drop an investigation in seconds')
})

test('the thresholds are 0.4 and 1.0, and crossing one is a transition', () => {
  assert.equal(beast.awarenessLevel(0), 'unaware')
  assert.equal(beast.awarenessLevel(0.3999999), 'unaware', 'a hair under 0.4 is still unaware')
  assert.equal(beast.awarenessLevel(0.4), 'investigate', '§6.2: 0.4-0.8 investigates')
  assert.equal(beast.awarenessLevel(0.7999), 'investigate')
  assert.equal(beast.awarenessLevel(0.9999999), 'investigate')
  assert.equal(beast.awarenessLevel(1), 'chase', '§6.2: 1.0 is the chase')
  assert.equal(beast.clampAwareness(beast.AWARENESS_INVESTIGATE), 0.4)
  // and the machine transitions on the frame the meter crosses, not a frame later
  let creature = beast.createCreature({ state: 'stalk' })
  let first = null
  for (let i = 0; i < 600 && first === null; i += 1) {
    const step = beast.creatureStep(creature, DT, { distance: 30, sounds: [{ kind: 'sprint', distance: 2 }] })
    creature = step.creature
    if (step.level === 'investigate') first = step
  }
  assert.ok(first, 'the meter never reached the investigate band')
  assert.ok(first.awareness >= beast.AWARENESS_INVESTIGATE, 'reported investigate below 0.4')
  assert.ok(first.awareness < 1)
  assert.equal(first.to, 'stalk', 'investigating is not yet a chase')
})

test('the meter clamps to [0, 1] and no event can overshoot a chase', () => {
  // a single loud event lands short of the ceiling
  const one = beast.awarenessStep(0.9, DT, { sounds: [{ kind: 'toll', distance: 0 }] }).awareness
  assert.ok(one <= 1 && one > 0.9, `one event gave ${one}`)
  // and no pile of them, or one enormous frame, gets past 1.0
  const flood = Array.from({ length: 500 }, () => ({ kind: 'toll', distance: 0 }))
  assert.equal(beast.awarenessStep(0.999, DT, { sounds: flood }).awareness, 1)
  assert.equal(beast.awarenessStep(0, 9999, { seen: true, sightDistance: 0, sightRange: 14 }).awareness, 1)
  assert.equal(beast.awarenessStep(0, 1e9, { sounds: flood, seen: true, sightDistance: 0 }).awareness, 1)
  // nonsense in, zero out — the meter is a game rule, not a source of NaN
  assert.equal(beast.awarenessStep(-5, DT, {}).awareness, 0)
  assert.equal(beast.awarenessStep(NaN, DT, {}).awareness, 0)
  assert.equal(beast.clampAwareness(1e9), 1)
  assert.equal(beast.clampAwareness(-1e9), 0)
  assert.equal(beast.clampAwareness(Infinity), 0)
})

test('sound falls off in metres and stops dead at the radius', () => {
  assert.equal(beast.soundStrength(0, 9), 1, 'at the source it is full strength')
  assert.equal(beast.soundStrength(4.5, 9), 0.5, 'half way out is half strength')
  assert.equal(beast.soundStrength(9, 9), 0, 'the edge of the radius is nothing')
  assert.equal(beast.soundStrength(9.01, 9), 0, 'past the radius is nothing')
  assert.equal(beast.soundStrength(-1, 9), 0)
  assert.equal(beast.soundStrength(5, 0), 0, 'a silent source has no strength to give')
  let previous = Infinity
  for (let distance = 0; distance <= 22; distance += 0.25) {
    const strength = beast.soundStrength(distance, 22)
    assert.ok(strength <= previous, `strength rose again at ${distance} m`)
    assert.ok(strength >= 0 && strength <= 1)
    previous = strength
  }
  // and the integration agrees with the table: one metre closer is a bigger bite
  const near = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 10 }] }).heard[0].step
  const far = beast.awarenessStep(0, DT, { sounds: [{ kind: 'sprint', distance: 11 }] }).heard[0].step
  assert.ok(near > far)
})

test('the fog curve only ever weakens a distant target', () => {
  assert.equal(beast.sightStrength(0, 14), 1)
  assert.equal(beast.sightStrength(14, 14), 0, 'the edge of the range is worth nothing')
  assert.equal(beast.sightStrength(20, 14), 0, 'past the range is worth nothing')
  assert.equal(beast.sightStrength(7, Infinity), 1, 'tier 3 has infinite vision (§11.1)')
  let previous = Infinity
  for (let distance = 0; distance <= 14; distance += 0.1) {
    const strength = beast.sightStrength(distance, 14)
    assert.ok(strength <= previous, `sight strength rose again at ${distance} m`)
    assert.ok(strength >= 0 && strength <= 1)
    previous = strength
  }
  // fog bites: the far end of the same range is worth less than the near end
  const half = 7
  assert.ok(beast.sightStrength(half, 14) < 1 - (half / 14), 'the fog term is doing nothing')
  assert.ok(beast.SIGHT_FOG_FALLOFF > 0 && beast.SIGHT_FOG_FALLOFF < 1)
})


test('line of sight is occlusion-aware, and only solid things occlude', () => {
  const hedge = { kind: 'hedge', x: 0, z: 0, w: 8, d: 1.2 }
  const car = { kind: 'car', x: 0, z: 0, w: 4.6, d: 2 }
  const house = { kind: 'house', x: 0, z: 0, w: 10, d: 8 }
  const south = { x: 0, z: -10 }
  const north = { x: 0, z: 10 }
  assert.equal(beast.lineOfSight(south, north, [hedge]), false, 'a hedge across the street blocks')
  assert.equal(beast.lineOfSight(south, north, [house]), false, 'a house volume blocks')
  assert.equal(beast.lineOfSight(south, { x: 30, z: 10 }, [hedge]), true, 'a line past the hedge is clear')
  assert.equal(beast.lineOfSight(south, north, [car]), true, 'a parked car is not a sight blocker (§6.3)')
  assert.equal(beast.lineOfSight(south, north, [{ ...hedge, occudes: false }]), true, 'and a caller can override')
  assert.equal(beast.lineOfSight(south, north, [{ ...car, occudes: true }]), false)
  // standing inside a hedge counts as blocked, and grazing past one does not
  assert.equal(beast.lineOfSight({ x: 0, z: 0 }, { x: 0, z: 5 }, [hedge]), false)
  assert.equal(beast.lineOfSight({ x: -4.01, z: -0.5 }, { x: 4.01, z: -0.5 }, [hedge]), false)
  assert.equal(beast.lineOfSight({ x: -4.01, z: 0.61 }, { x: 4.01, z: 0.61 }, [hedge]), true)
  assert.equal(beast.segmentHitsRect(south, north, { x: 0, z: 0, w: 0, d: 0 }), true, 'a point blocks too')
  assert.equal(beast.lineOfSight(south, north, []), true, 'an empty street is always clear')
  assert.equal(beast.lineOfSight(null, north, [hedge]), false, 'no point, no sightline')
  assert.equal(beast.lineOfSight(south, undefined, []), false)
  assert.equal(beast.lineOfSight(south, north, [null, undefined, hedge]), false)
  // the real footprint shape: one chunk's fixtures, with no neighbourhood walk
  const fixtures = hood.chunkFixtures(1337, 1, 2, 3, new Set())
  assert.ok(fixtures.length > 0, 'the chunk under test has no fixtures at all')
  for (const fixture of fixtures) {
    assert.equal(beast.isOccluder(fixture), beast.OCCLUDER_KINDS.includes(fixture.kind), `${fixture.kind} occludes`)
    const through = { x: fixture.x, z: fixture.z - 1 }
    assert.equal(beast.segmentHitsRect(through, { x: fixture.x, z: fixture.z + 1 }, fixture), true)
  }
})

test('the sight cone is ~70 degrees and yaw 0 faces -Z like the player', () => {
  assert.ok(Math.abs((beast.SIGHT_HALF_ANGLE * 180) / Math.PI - 35) < 1e-9, 'a 70 degree cone')
  // player.js: forward is (-sin yaw, -cos yaw), so yaw 0 looks down -Z.
  // `-Math.sin(0)` is -0, which is why these are compared by magnitude.
  assert.ok(Math.abs(beast.forwardOf(0).x) < 1e-15)
  assert.equal(beast.forwardOf(0).z, -1)
  assert.ok(Math.abs(beast.forwardOf(Math.PI / 2).x + 1) < 1e-12, 'and turns toward -X')
  const offAxis = (degrees, distance) => {
    const radians = (degrees * Math.PI) / 180
    const f = beast.forwardOf(0)
    const right = { x: -f.z, z: f.x }
    return {
      x: (f.x * Math.cos(radians) + right.x * Math.sin(radians)) * distance,
      z: (f.z * Math.cos(radians) + right.z * Math.sin(radians)) * distance,
    }
  }
  const eye = { x: 0, z: 0, yaw: 0 }
  assert.equal(beast.inSightCone(eye, offAxis(0, 10)), true)
  assert.equal(beast.inSightCone(eye, offAxis(30, 10)), true, '30 degrees off is inside a 35 degree half-angle')
  assert.equal(beast.inSightCone(eye, offAxis(-30, 10)), true)
  assert.equal(beast.inSightCone(eye, offAxis(40, 10)), false)
  assert.equal(beast.inSightCone(eye, offAxis(180, 10)), false, 'directly behind is not in the cone')
  assert.equal(beast.inSightCone(eye, { x: 0, z: 0 }), true, 'a target on top of it is in the cone')
  // yawBetween round-trips, so the view layer can point the creature at a target
  const target = offAxis(-22, 30)
  const f = beast.forwardOf(beast.yawBetween(eye, target))
  assert.ok(Math.abs((f.x * target.x + f.z * target.z) / 30 - 1) < 1e-9)
  // and canSee is all three tests at once
  assert.equal(beast.canSee(eye, offAxis(0, 10), { range: 14 }), true)
  assert.equal(beast.canSee(eye, offAxis(0, 15), { range: 14 }), false, 'out of range at tier 0 (§11.1)')
  assert.equal(beast.canSee(eye, offAxis(0, 15), { range: 17 }), true, 'the same target at tier 1')
  assert.equal(beast.canSee(eye, offAxis(0, 40), { range: Infinity }), true, 'tier 3 always knows (§10.2)')
  assert.equal(beast.canSee(eye, offAxis(40, 10), { range: Infinity }), false, 'even at infinite range the cone holds')
  assert.equal(
    beast.canSee(eye, offAxis(0, 10), { range: Infinity, occluders: [{ kind: 'hedge', x: 0, z: -5, w: 8, d: 1.2 }] }),
    false,
    'and a hedge still blocks at infinite range',
  )
  assert.equal(beast.canSee(null, offAxis(0, 1), {}), false)
})

// ---------------------------------------------------------------------------
// v2 slice 06 — the scripted run, and the state machine it drives
// ---------------------------------------------------------------------------

const CREATURE_DT = 1 / 60
// the player's real cadences, from player.js: a 1.7 m stride at 3.6 and 6.0 m/s
const WALK_STRIDE_FRAMES = Math.round(0.47 / CREATURE_DT)
const SPRINT_STRIDE_FRAMES = Math.round(0.28 / CREATURE_DT)
// a continuous source emits one event per integration window, not one per frame
const SHUTDOWN_FRAMES = Math.round(beast.SOUND_EVENT_SECONDS / CREATURE_DT)

/**
 * creatureScript — one Act I to Act III run, as a fixed list of frames.
 *
 * Every phase is a legal thing a player can do, and between them they exercise
 * every edge in `TRANSITIONS`, so the machine's data table can be checked
 * against the machine itself rather than against itself. The distances and
 * cadences are the real ones from §6.2 and player.js: a 9 m whisper, a 22 m
 * sprint, a 25 m shutdown at its documented window rate, and a 30 m toll.
 */
function creatureScript() {
  const where = { x: 4, z: 4 } // the player, parked at a lot corner
  const script = []
  let frame = 0
  const phase = (label, frames, make) => {
    for (let i = 0; i < frames; i += 1) {
      script.push({ at: frame, label, frame: typeof make === 'function' ? make(i, frame) : make })
      frame += 1
    }
  }
  // a gait at its real cadence: footsteps on a stride, a shutdown on its window
  const gait = (label, kind, soundDistance, distance, every, frames) => {
    phase(label, frames, (i, at) => ({
      distance,
      sounds: at % every === 0 ? [{ kind, distance: soundDistance, position: where }] : [],
    }))
  }
  const quiet = (label, frames, distance = 40, extra = {}) => phase(label, frames, { distance, ...extra })

  // Act I. The player walks up to the apparition: in its cone, on top of it,
  // sprinting, with the hammer tolling, all at once. §8.1 says none of that
  // matters, and this is where that promise is spent.
  phase('act I in its face', 90, () => ({
    sighting: true,
    seen: true,
    sightDistance: 0.2,
    playerPosition: where,
    distance: 0.2,
    sounds: [
      { kind: 'sprint', distance: 0.2 },
      { kind: 'toll', distance: 0.2, position: where },
    ],
  }))

  // §7.2: the pickup tolls once, at maximum radius, and Act II begins.
  phase('hammer pickup', 1, {
    sighting: true,
    distance: 30,
    hammerPickup: true,
    sounds: [{ kind: 'toll', distance: 0, position: where }],
  })

  // Act II. First the player tries the quiet option: walking at 4 m. Over five
  // seconds of it the meter barely twitches, because a footstep is a 9 m whisper
  // and the creature is four metres away with something else to listen to. This
  // is §6.2's "kill your footsteps" clause, and the phase is in the script so the
  // claim is measured rather than asserted.
  gait('walking quietly', 'walk', 4, 4, WALK_STRIDE_FRAMES, 300)
  // then the player panics, which is the loudest thing available
  gait('sprinting past', 'sprint', 5, 5, SPRINT_STRIDE_FRAMES, 360)
  // it breaks contact, and the meter bleeds the rest of the way down
  quiet('breaking contact', 4)
  quiet('silence', 620)
  // the path layer works out the last-heard street and asks for a new one
  quiet('search exhausted', 1, 40, { searchExhausted: true })
  quiet('the search fails', 300)
  quiet('search exhausted again', 1, 40, { searchExhausted: true })
  quiet('new origin offered', 1, 40, { searchPosition: { x: -60, z: 8 } })
  // a portal shutdown at 12 m: heard, committed to, worked out — and not enough,
  // which is the whole reason the hammer has to exist
  gait('portal shutdown', 'portal', 12, 12, SHUTDOWN_FRAMES, 240)
  quiet('search exhausted once more', 1, 12, { searchExhausted: true })
  quiet('new origin again', 1, 12, { searchPosition: { x: -60, z: 8 } })
  // §7.4: the swing connects. STAGGER is the recoil, DORMANT is the removal.
  quiet('swing connects', 1, 2, { swing: true })
  quiet('banished', 120, 60)
  quiet('gone', 60, 60)
  quiet('re-emergence', 1, 60, { reemerge: true })
  // a second Act II, heard at 3 m, and this time it does become a chase
  gait('heard at three metres', 'sprint', 3, 3, SPRINT_STRIDE_FRAMES, 300)
  // the finale, mid-chase (§6.1, §10.2): it stops searching and simply knows
  quiet('third portal', 1, 3, { finale: true })
  quiet('enraged knowledge', 240, 30)
  // §10.2: the hammer still works in the finale, it just does not wait
  quiet('swing in the finale', 1, 1.5, { swing: true })
  quiet('banished in the finale', 120, 60)
  quiet('flat re-emergence', 1, 60, { reemerge: true })
  // and the enrage edge again, out of a stalk rather than out of a chase
  quiet('third portal from a stalk', 1, 40, { finale: true })
  quiet('swing to put it back to sleep', 1, 1.5, { swing: true })
  quiet('banished again', 120, 60)
  quiet('third re-emergence', 1, 60, { reemerge: true })
  // the last three edges, all of them out of REPOSITION: it is the state the
  // design spends the most prose on and the one a careless refactor loses
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options', 1, 8, { searchExhausted: true })
  quiet('the last portal', 1, 8, { finale: true })
  quiet('swing in the finale again', 1, 1.5, { swing: true })
  quiet('banished once more', 120, 60)
  quiet('fourth re-emergence', 1, 60, { reemerge: true })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options again', 1, 8, { searchExhausted: true })
  quiet('swing while searching', 1, 2, { swing: true })
  quiet('banished', 120, 60)
  quiet('fifth re-emergence', 1, 60, { reemerge: true })
  gait('hunting again', 'portal', 8, 8, SHUTDOWN_FRAMES, 120)
  quiet('out of options once more', 1, 8, { searchExhausted: true })
  gait('it finds the street', 'sprint', 2, 2, SPRINT_STRIDE_FRAMES, 300)
  // the last swing of the run, thrown mid-chase with the creature in view. This
  // is the only way a CHASE reaches STAGGER: break the sightline on the swing
  // frame and the meter drops out of the chase on that same frame instead.
  quiet('swing in the chase', 1, 1.5, { swing: true, seen: true, sightDistance: 1.5 })
  quiet('banished at the end', 120, 60)
  return script
}

/** A sighting that ends: the one Act I exit the run above does not need. */
function sightingScript() {
  return [
    { at: 0, label: 'apparition', frame: { sighting: true, distance: 60 } },
    { at: 1, label: 'looked away', frame: { sighting: false, distance: 60 } },
    { at: 2, label: 'gone', frame: { distance: 60 } },
  ]
}


// ---------------------------------------------------------------------------
// PRNG + determinism (the learnable pattern)
// ---------------------------------------------------------------------------

/**
 * runCreatureScript — replay a script and record what happened, as both a
 * readable trace and the set of edges the machine actually took.
 */
function runCreatureScript(script, start) {
  let creature = start ?? beast.createCreature()
  const lines = []
  const edges = new Set()
  const history = []
  for (const entry of script) {
    const step = beast.creatureStep(creature, CREATURE_DT, entry.frame)
    if (step.changed) edges.add(`${step.from}>${step.to}`)
    // the meter is a game rule, not a float: assert it on every frame of every run
    assert.ok(step.awareness >= 0 && step.awareness <= 1, `frame ${entry.at}: awareness ${step.awareness}`)
    assert.ok(beast.CREATURE_STATES.includes(step.to), `frame ${entry.at}: state ${step.to}`)
    lines.push(
      [
        String(entry.at).padStart(4, '0'),
        entry.label,
        `${step.from}>${step.to}`,
        step.awareness.toFixed(6),
        step.level,
        `heard=${step.heard.length}`,
        `toll=${step.creature.hammerToll ? 1 : 0}`,
        `captured=${step.captured ? 1 : 0}`,
      ].join(' '),
    )
    history.push({ ...entry, ...step })
    creature = step.creature
  }
  return { creature, trace: lines.join('\n'), edges, history, frames: lines.length }
}

section('Creature state machine (v2 slice 06)')

test('TELEGRAPH has no capture path at all (§8.1)', () => {
  // the exhaustive statement: only a chase or the finale can end a run
  assert.deepEqual([...beast.CAPTURE_STATES].sort(), ['chase', 'enraged'])
  for (const state of beast.CREATURE_STATES) {
    for (const distance of [0, 0.001, 0.5, 1, 1.1, 1.2, 5, 100]) {
      const expected = beast.CAPTURE_STATES.includes(state) && distance <= beast.CAPTURE_RADIUS
      const label = `${state} at ${distance} m`
      assert.equal(beast.canCapture(state, distance), expected, label)
      assert.equal(beast.canCapture({ state, awareness: 1 }, distance), expected, `${label}, full meter`)
    }
  }
  assert.equal(beast.canCapture('telegraph', 0, 1000), false, 'not even at a kilometre')
  assert.equal(beast.canCapture('telegraph', NaN), false)
  assert.equal(beast.canCapture(null, 0), false)
  assert.equal(beast.canCapture(undefined, 0), false)
  assert.equal(beast.canCapture('stalk', 0), false, 'a creature that does not know where you are cannot grab you')
  assert.equal(beast.canCapture('reposition', 0), false)
  assert.equal(beast.canCapture('stagger', 0), false, `${beast.STAGGER_SECONDS} s of relief per connected swing`)
  assert.equal(beast.canCapture('dormant', 0), false, 'and it is gone entirely afterwards')
  // the whole of Act I, run as hard as it can be run
  let creature = beast.createCreature()
  for (let i = 0; i < 400; i += 1) {
    const step = beast.creatureStep(creature, DT, {
      sighting: true,
      seen: true,
      sightDistance: 0,
      playerPosition: { x: 4, z: 4 },
      distance: 0,
      sounds: [{ kind: 'sprint', distance: 0 }, { kind: 'toll', distance: 0 }],
    })
    assert.equal(step.captured, false, `Act I caught the player on frame ${i}`)
    assert.equal(step.awareness, 0, `Act I learned something on frame ${i}`)
    assert.equal(step.to, 'telegraph')
    creature = step.creature
  }
  // §6.1: it cannot be banished either
  const swing = beast.creatureStep(creature, DT, { sighting: true, distance: 0, swing: true, sounds: [] })
  assert.equal(swing.swing.result, 'immune', 'TELEGRAPH must not be banishable')
  assert.equal(swing.to, 'telegraph')
  assert.equal(swing.captured, false)
  // and no documented edge out of TELEGRAPH lands anywhere that can capture
  for (const edge of beast.TRANSITIONS.filter((row) => row.from === 'telegraph')) {
    assert.ok(!beast.CAPTURE_STATES.includes(edge.to), `TELEGRAPH -> ${edge.to} is a capture path`)
  }
  assert.equal(beast.resolveSwing('telegraph', 0).result, 'immune')
  assert.equal(beast.resolveSwing('dormant', 0).result, 'immune')
})

test('capture is the end of a chase, and only of a chase', () => {
  const chasing = beast.createCreature({ state: 'chase', awareness: 1 })
  assert.equal(beast.canCapture(chasing, beast.CAPTURE_RADIUS), true)
  assert.equal(beast.canCapture(chasing, beast.CAPTURE_RADIUS + 0.01), false, 'one centimetre further is safe')
  assert.equal(beast.canCapture(chasing, 0), true, 'standing in it is a capture')
  const caught = beast.creatureStep(chasing, DT, { distance: 0.4, seen: true, sightDistance: 0.4 })
  assert.equal(caught.captured, true)
  assert.equal(caught.to, 'chase', 'a capture is not a transition; the world handles the reset (§9.1)')
  // and the reset it hands back to is a state this module agrees with
  const run = rules.createInitialState(hood.placeObjectives(1337, 1))
  run.hammerHeld = true
  const after = rules.applyCapture(run)
  assert.equal(after.creature.state, 'stalk', 'a capture returns the creature to STALK in Act II')
  assert.equal(after.creature.awareness, 0, 'and takes its knowledge with it')
  // the finale ignores range for the meter but not for its own reach
  const enraged = beast.createCreature({ state: 'enraged' })
  assert.equal(beast.canCapture(enraged, 3), false, '§10.2 buys knowledge and speed, not reach')
  assert.equal(beast.canCapture(enraged, 0.5), true)
})

test('a connected swing is a full removal, never a stagger-only outcome', () => {
  // §7.4, exhaustively: inside the range is a banish, outside it is a miss
  assert.equal(beast.resolveSwing('chase', 0).result, 'banish')
  assert.equal(beast.resolveSwing('chase', beast.BANISH_RANGE).result, 'banish')
  assert.equal(beast.resolveSwing('chase', beast.BANISH_RANGE + 0.01).result, 'miss')
  assert.equal(beast.resolveSwing('chase', Infinity).result, 'miss')
  assert.equal(beast.resolveSwing('chase', NaN).result, 'miss')
  assert.equal(beast.resolveSwing('stalk', 1).flat, false)
  assert.equal(beast.resolveSwing('enraged', 1).flat, true, '§10.2: the ladder is ignored in the finale')
  // and from every state a swing can land in, the run ends in DORMANT. STAGGER
  // is the recoil on the way, never a place the creature gets to stay.
  const driving = {
    stalk: (creature) => creature,
    chase: (creature) => ({ ...creature, state: 'chase', awareness: 1 }),
    reposition: (creature) => ({ ...creature, state: 'reposition', awareness: 0.5 }),
  }
  for (const [state, prepare] of Object.entries(driving)) {
    const start = prepare(beast.createCreature({ state: 'stalk' }))
    const swing = beast.creatureStep(start, DT, { distance: 1, swing: true, sounds: [{ kind: 'sprint', distance: 1 }] })
    assert.equal(swing.swing.result, 'banish', `${state}: a connected swing must banish`)
    assert.equal(swing.to, 'stagger', `${state}: the recoil`)
    assert.equal(swing.creature.banishPending, true)
    assert.equal(swing.captured, false, `${state}: the recoil is also the 1.6 s of relief`)
    // and it leaves for DORMANT, not back into the hunt
    let creature = swing.creature
    let left = null
    for (let i = 0; i < 200 && left === null; i += 1) {
      const step = beast.creatureStep(creature, DT, { distance: 30, sounds: [] })
      creature = step.creature
      if (step.changed) left = step
    }
    assert.ok(left, `${state}: the banish never completed`)
    assert.equal(left.to, 'dormant', `${state}: a banish must end in DORMANT`)
    assert.equal(creature.awareness, 0, `${state}: a removal takes its knowledge with it`)
    assert.equal(creature.banishPending, false)
    assert.equal(beast.canCapture(creature, 0), false, `${state}: and it cannot catch you on its way out`)
  }
  // a miss changes nothing but the toll, which the world plays on its own
  const missed = beast.creatureStep(beast.createCreature({ state: 'stalk' }), DT, {
    distance: beast.BANISH_RANGE + 1,
    swing: true,
    sounds: [],
  })
  assert.equal(missed.swing.result, 'miss')
  assert.equal(missed.to, 'stalk')
  assert.equal(missed.changed, false)
})

test('the hammer pickup is the only awakening (§7.2)', () => {
  const asleep = beast.createCreature()
  assert.equal(asleep.state, 'telegraph')
  const tolled = beast.creatureStep(asleep, DT, { sighting: true, distance: 60, hammerPickup: true, sounds: [] })
  assert.equal(tolled.to, 'stalk', 'the toll is the awakening')
  assert.equal(tolled.creature.hammerToll, true, 'and it is recorded for the view and audio layers')
  assert.equal(tolled.awareness, 0, 'the awakening is not a sighting')
  // nothing else wakes it: noise, sight and contact, in Act I, do nothing
  for (let i = 0; i < 120; i += 1) {
    const step = beast.creatureStep(asleep, DT, {
      sighting: true,
      seen: true,
      sightDistance: 0,
      distance: 0,
      sounds: [{ kind: 'sprint', distance: 0 }, { kind: 'toll', distance: 0 }],
    })
    assert.equal(step.to, 'telegraph', `frame ${i} woke the creature without the hammer`)
  }
  // a sighting that ends goes back to DORMANT, which is "pre-awakening" (§6.1)
  const faded = runCreatureScript(sightingScript())
  assert.deepEqual([...faded.edges], ['telegraph>dormant'])
  assert.equal(faded.creature.awareness, 0)
  // and DORMANT only re-emerges when the path layer says so
  const still = beast.creatureStep(faded.creature, DT, { distance: 60, sounds: [] })
  assert.equal(still.to, 'dormant')
  const back = beast.creatureStep(faded.creature, DT, { distance: 60, reemerge: true, sounds: [] })
  assert.equal(back.to, 'stalk', '§8.3: it comes back, at a distance the world chooses')
  assert.equal(back.creature.reemergenceCount, 1)
})

test('REPOSITION asks for a new origin and gives up when the meter empties', () => {
  const searching = beast.createCreature({ state: 'reposition', awareness: 0.5 })
  // the path layer offers an origin and the search resumes (§6.1)
  const offered = beast.creatureStep(searching, DT, { distance: 30, searchPosition: { x: -60, z: 8 }, sounds: [] })
  assert.equal(offered.to, 'stalk')
  assert.deepEqual(offered.creature.lastHeard, { x: -60, z: 8 }, 'STALK commits to the position it was given')
  // STALK is what asks for the new origin in the first place
  const asked = beast.creatureStep(beast.createCreature({ state: 'stalk', awareness: 0.5 }), DT, {
    distance: 30,
    searchExhausted: true,
    sounds: [],
  })
  assert.equal(asked.to, 'reposition')
  // with no offer and a louder stimulus it commits instead of asking
  let hunting = searching
  let committed = null
  for (let i = 0; i < 300 && committed === null; i += 1) {
    const step = beast.creatureStep(hunting, DT, { distance: 30, sounds: [{ kind: 'sprint', distance: 1 }] })
    hunting = step.creature
    if (step.changed) committed = step
  }
  assert.ok(committed, 'a searching creature never committed to a chase')
  assert.equal(committed.from, 'reposition', 'and it must have been the one searching')
  assert.equal(committed.to, 'chase')
  // and the quiet is what makes it give up: below 0.4 there is nothing to search for
  let wandering = searching
  let gaveUp = null
  for (let i = 0; i < 300 && gaveUp === null; i += 1) {
    const step = beast.creatureStep(wandering, DT, { distance: 30, sounds: [] })
    wandering = step.creature
    if (step.changed) gaveUp = step
  }
  assert.ok(gaveUp, 'a searching creature never gave up')
  assert.equal(gaveUp.from, 'reposition')
  assert.equal(gaveUp.to, 'stalk')
  assert.equal(gaveUp.creature.lastHeard, null, 'a wander has no position to commit to')
  assert.ok(gaveUp.awareness < beast.AWARENESS_INVESTIGATE, `gave up at ${gaveUp.awareness}`)
  // a repositioning creature is not a chasing one, whatever the distance
  assert.equal(beast.canCapture({ state: 'reposition', awareness: 1 }, 0), false)
})

test('the finale edge cannot fire into or out of Act I (§6.1, §10.2)', () => {
  for (const state of ['stalk', 'reposition', 'chase']) {
    const step = beast.creatureStep(beast.createCreature({ state, awareness: 0.9 }), DT, { distance: 30, finale: true })
    assert.equal(step.to, 'enraged', `${state} should enrage`)
  }
  // and it never rescues a pre-awakening or a banished creature
  for (const state of ['telegraph', 'dormant']) {
    const step = beast.creatureStep(beast.createCreature({ state }), DT, { distance: 30, finale: true })
    assert.equal(step.to, state, `${state} must not be reachable from the finale`)
  }
  // a banish in flight is not cancelled by the finale
  const stunned = beast.creatureStep(
    { ...beast.createCreature({ state: 'stagger', awareness: 0.8 }), staggerSeconds: 1, banishPending: true },
    DT,
    { distance: 30, finale: true, sounds: [] },
  )
  assert.equal(stunned.to, 'stagger', 'a banish in flight is not cancelled by the finale')
  // §10.2: permanent position knowledge, and no decay at all
  const enraged = beast.createCreature({ state: 'enraged' })
  let creature = enraged
  for (let i = 0; i < 600; i += 1) creature = beast.creatureStep(creature, DT, { distance: 200, sounds: [] }).creature
  assert.equal(creature.state, 'enraged', 'it never gives up searching')
  assert.equal(creature.awareness, 1, '§10.2: no awareness decay, it always knows')
  // and it is still banishable, because the hammer has to stay relevant (§10.2)
  const hit = beast.creatureStep({ ...enraged }, DT, { distance: 1, swing: true, sounds: [] })
  assert.equal(hit.swing.result, 'banish')
  assert.equal(hit.swing.flat, true, 'the ladder is ignored, so re-emergence is a flat delay')
})

test('every documented transition is real, and every real transition is documented', () => {
  const observed = new Set([...runCreatureScript(creatureScript()).edges, ...runCreatureScript(sightingScript()).edges])
  const documented = new Set(beast.TRANSITIONS.map((row) => `${row.from}>${row.to}`))
  for (const edge of documented) {
    assert.ok(observed.has(edge), `TRANSITIONS documents ${edge}, which the machine never does. Observed: ${[...observed].join(' ')}`)
    assert.ok(beast.CREATURE_STATES.includes(edge.split('>')[0]), `${edge} starts outside the state list`)
    assert.ok(beast.CREATURE_STATES.includes(edge.split('>')[1]), `${edge} ends outside the state list`)
  }
  for (const edge of observed) {
    assert.ok(documented.has(edge), `the machine takes ${edge}, which TRANSITIONS does not document`)
  }
  assert.equal(observed.size, documented.size, 'the two descriptions of the machine disagree')
  // no duplicates in the table either: one row per edge, or the check above lies
  assert.equal(documented.size, beast.TRANSITIONS.length, 'TRANSITIONS has a duplicated row')
})

test('a chase survives a lapse of noise instead of flickering (the 0.8 release)', () => {
  // the commit threshold and the release threshold are different numbers, and the
  // release one is §6.2's own investigate ceiling
  assert.equal(beast.AWARENESS_CHASE_RELEASE, 0.8)
  assert.ok(beast.AWARENESS_CHASE_RELEASE < beast.AWARENESS_CHASE)
  assert.ok(beast.AWARENESS_CHASE_RELEASE > beast.AWARENESS_INVESTIGATE)
  // a chase that is tracking a sprinting player must not drop out between strides
  let creature = beast.createCreature({ state: 'chase', awareness: 1 })
  for (let at = 0; at < 240; at += 1) {
    const step = beast.creatureStep(creature, DT, {
      distance: 6,
      sounds: at % SPRINT_STRIDE_FRAMES === 0 ? [{ kind: 'sprint', distance: 6 }] : [],
    })
    assert.equal(step.to, 'chase', `the chase flickered to ${step.to} on frame ${at}`)
  }
  // and it releases on the documented frame, not a stride later
  creature = beast.createCreature({ state: 'chase', awareness: beast.AWARENESS_CHASE_RELEASE })
  const held = beast.creatureStep(creature, DT, { distance: 60, seen: true, sightDistance: 60, sightRange: 14 })
  assert.equal(held.to, 'chase', 'exactly at the release threshold is still a chase')
  assert.equal(beast.creatureStep(creature, DT, { distance: 60, sounds: [] }).to, 'stalk')
  // silence is what gets it out of the chase, and the meter says how long that is
  creature = beast.createCreature({ state: 'chase', awareness: 0.95 })
  let heldFrames = 0
  while (heldFrames < 600) {
    const step = beast.creatureStep(creature, DT, { distance: 60, sounds: [] })
    creature = step.creature
    heldFrames += 1
    if (step.to !== 'chase') break
  }
  assert.equal(creature.state, 'stalk')
  assert.ok(heldFrames > 30, `silence released the chase after only ${heldFrames} frames`)
  const expected = (0.95 - beast.AWARENESS_CHASE_RELEASE) / beast.AWARENESS_DECAY_PER_SEC
  assert.ok(Math.abs(heldFrames * DT - expected) < 0.05, `released after ${(heldFrames * DT).toFixed(2)}s, expected ${expected.toFixed(2)}s`)
  assert.ok((1 - beast.AWARENESS_CHASE_RELEASE) / beast.AWARENESS_DECAY_PER_SEC < 2, 'a chase must be losable')
  // §8.2: the chase clock runs while it is chasing, for slice 07's phase-out
  creature = beast.createCreature({ state: 'chase', awareness: 1 })
  for (let i = 0; i < 720; i += 1) {
    creature = beast.creatureStep(creature, DT, { distance: 6, seen: true, sightDistance: 6 }).creature
  }
  assert.ok(creature.chaseSeconds > 11, `chaseSeconds is ${creature.chaseSeconds}, CHASE_MAX_SECONDS is ~12`)
  assert.equal(creature.state, 'chase', 'and slice 07 is what ends it, not this slice')
})

test('a scripted event sequence replays byte-identically (§15.3)', () => {
  const script = creatureScript()
  const first = runCreatureScript(script)
  const second = runCreatureScript(script)
  const encode = new TextEncoder()
  // byte-identical, not "close enough": the whole trace, encoded
  assert.deepEqual(encode.encode(second.trace), encode.encode(first.trace), 'the trace drifted on replay')
  assert.ok(first.frames > 2000, `the scripted run is only ${first.frames} frames long`)
  // and it survives other work happening in between, which is where a
  // module-level cache or a leaked global would show up
  hood.placeObjectives(4242, 7)
  beast.awarenessStep(0.5, 1, { sounds: [{ kind: 'sprint', distance: 2 }] })
  beast.creatureStep(beast.createCreature(), DT, { hammerPickup: true, sighting: true })
  runCreatureScript(sightingScript())
  const third = runCreatureScript(script)
  assert.deepEqual(encode.encode(third.trace), encode.encode(first.trace), 'other work changed the trace')
  // the comparison means something only if the trace depends on the sequence:
  // reordered frames, one extra noise event, and a swing that lands half a metre
  // too far must each change it
  const reversed = runCreatureScript(script.slice().reverse())
  assert.notDeepEqual(encode.encode(reversed.trace), encode.encode(first.trace), 'the trace ignored the order')
  const nudge = 400
  const noised = script.map((entry, i) =>
    i === nudge ? { ...entry, frame: { ...entry.frame, sounds: [{ kind: 'toll', distance: 1 }] } } : entry,
  )
  assert.notDeepEqual(encode.encode(runCreatureScript(noised).trace), encode.encode(first.trace), 'one event changed nothing')
  // a swing that lands half a metre too far is a miss, and a miss is a different run
  const swingAt = script.findIndex((entry) => entry.label === 'swing connects')
  const missed = script.map((entry, i) =>
    i === swingAt ? { ...entry, frame: { ...entry.frame, distance: beast.BANISH_RANGE + 1 } } : entry,
  )
  assert.notDeepEqual(encode.encode(runCreatureScript(missed).trace), encode.encode(first.trace), 'a missed swing changed nothing')
  // and the tier the world carries makes no difference here, because this slice
  // reads no tier-dependent constant: the §11.1 ramp arrives per frame as
  // `sightRange` and arrives in full in slice 07
  const tiered = runCreatureScript(script, beast.createCreature({ state: 'telegraph', tier: 3 }))
  assert.deepEqual(encode.encode(tiered.trace), encode.encode(first.trace), 'the tier leaked into the meter')
  // which is not the same as saying range is ignored — it is an input, and the
  // run above never relies on it (the player is not seen outside Act I), so it
  // gets its own script here
  const watching = (range) =>
    runCreatureScript(
      Array.from({ length: 60 }, (i, at) => ({ at, label: 'watched', frame: { distance: 8, seen: true, sightDistance: 8, sightRange: range } })),
      beast.createCreature({ state: 'stalk' }),
    )
  const near = watching(14)
  const tiered3 = watching(3)
  assert.ok(
    near.creature.awareness > tiered3.creature.awareness,
    `tier 1 saw ${near.creature.awareness.toFixed(4)}, tier 0 saw ${tiered3.creature.awareness.toFixed(4)}`,
  )
  assert.notDeepEqual(encode.encode(tiered3.trace), encode.encode(near.trace))
})

test('the scripted run tells the §6 and §7 story without breaking a rule', () => {
  const run = runCreatureScript(creatureScript())
  const at = (label) => run.history.find((row) => row.label === label)
  const awake = at('hammer pickup')
  // §8.1: everything before the hammer is inert, whatever the player does
  for (const row of run.history.filter((entry) => entry.at < awake.at)) {
    assert.equal(row.from, 'telegraph', `frame ${row.at} left Act I early`)
    assert.equal(row.awareness, 0, `frame ${row.at} learned something in Act I`)
    assert.equal(row.captured, false, `frame ${row.at} was a capture in Act I`)
  }
  // §7.2: the toll is the awakening, and it costs the player nothing
  assert.equal(awake.from, 'telegraph')
  assert.equal(awake.to, 'stalk')
  assert.equal(awake.creature.hammerToll, true)
  assert.equal(run.history[awake.at + 1].level, 'unaware', 'the awakening is not a sighting')
  // §6.2: the hunt escalates — sprinting brings it to a chase, silence loses it
  const firstInvestigate = run.history.find((row) => row.level === 'investigate')
  assert.ok(firstInvestigate.at > awake.at, 'it was investigating before the hammer')
  // and the quiet option is a real one: five seconds of walking at 4 m does not
  // even reach the investigate band, which is what "kill your footsteps" means
  const quiet = run.history.filter((row) => row.label === 'walking quietly')
  assert.ok(quiet.length > 200, 'the walk phase is too short to prove anything')
  for (const row of quiet) {
    assert.equal(row.to, 'stalk', 'walking quietly started something')
    assert.equal(row.level, 'unaware', `walking quietly reached ${row.level} at ${row.awareness.toFixed(3)}`)
  }
  const firstChase = run.history.find((row) => row.to === 'chase')
  assert.ok(firstChase.at > firstInvestigate.at, 'it chased before it investigated')
  assert.equal(firstChase.awareness, 1, 'and a chase is entered at exactly 1.0')
  assert.ok(firstChase.from === 'stalk' || firstChase.from === 'reposition')
  const losingIt = run.history.find((row) => row.at > firstChase.at && row.from === 'chase' && row.to === 'stalk')
  assert.ok(losingIt, 'the chase never ended')
  assert.ok(losingIt.awareness < beast.AWARENESS_CHASE_RELEASE, `released at ${losingIt.awareness}`)
  assert.equal(losingIt.heard.length, 0, 'and it ended because the player went quiet')
  // §7.4: every connected swing ends in a banish, and the banish completes
  const swings = run.history.filter((row) => row.swing && row.swing.result === 'banish')
  assert.equal(swings.length, 6, 'the run contains six connected swings')
  for (const swing of swings) {
    assert.equal(swing.to, 'stagger', `frame ${swing.at}: a banish that did not stagger`)
    const banishEnd = run.history.find((row) => row.at > swing.at && row.to === 'dormant')
    assert.ok(banishEnd, `frame ${swing.at}: a banish that never completed`)
    const between = run.history.filter((row) => row.at > swing.at && row.at < banishEnd.at)
    for (const row of between) {
      assert.equal(row.to, 'stagger', `frame ${row.at}: it was hunting during its own banish`)
      assert.equal(row.captured, false, `frame ${row.at}: caught during the recoil`)
    }
  }
  // §9.1: a banish does not advance the capture counter, and this run never
  // caught anybody at all. Six banishes, five re-emergences: the run ends banished.
  assert.ok(run.history.every((row) => row.captured === false), 'the scripted player was caught')
  assert.equal(run.creature.reemergenceCount, 5, 'five re-emergences, six banishes')
  // §10.2: the finale takes the knowledge away for good
  const finale = at('third portal')
  assert.equal(finale.to, 'enraged')
  const afterFinale = run.history.filter((row) => row.at > finale.at)
  assert.ok(afterFinale.length > 0)
  for (const row of afterFinale) {
    if (row.to === 'enraged') assert.equal(row.awareness, 1, `frame ${row.at}: an enraged creature forgot`)
  }
  // and the run ends banished rather than mid-hunt, with the meter empty
  assert.equal(run.creature.state, 'dormant')
  assert.equal(run.creature.awareness, 0)
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
